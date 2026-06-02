// Medcare AWV Eligibility Check
// Internal use only - called by Vapi voice agent during patient calls
// Flow: pVerify Token -> PatientFinder -> GetPatientFinderResponse -> MBIInquiry

const https = require("https");
const querystring = require("querystring");

const PVERIFY_BASE = "api.pverify.com";
const CLIENT_ID = process.env.PVERIFY_CLIENT_ID || "811ff04a-abe0-4546-87c5-ece4288ef8e4";
const CLIENT_SECRET = process.env.PVERIFY_CLIENT_SECRET || "S1KKfZSkzg6jZHUY7SgSJZmPPmjmMg";
const PROVIDER_LAST_NAME = "Rishmawi";
const PROVIDER_NPI = "1437443082";

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ _raw: data, _status: res.statusCode }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeDob(dob) {
  const s = String(dob || "").trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  return s;
}

async function getPverifyToken() {
  const body = querystring.stringify({
    Client_ID: CLIENT_ID,
    Client_Secret: CLIENT_SECRET,
    grant_type: "client_credentials",
  });
  return httpsRequest({
    hostname: PVERIFY_BASE,
    path: "/Token",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
}

async function pverifyPost(path, token, data) {
  const body = JSON.stringify(data);
  return httpsRequest({
    hostname: PVERIFY_BASE,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "Client-API-Id": CLIENT_ID,
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
}

async function pverifyGet(path, token) {
  return httpsRequest({
    hostname: PVERIFY_BASE,
    path,
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Client-API-Id": CLIENT_ID,
    },
  });
}

async function checkEligibility(firstName, lastName, dob) {
  const dobFmt = normalizeDob(dob);

  try {
    // Step 1: Get token
    const tokenData = await getPverifyToken();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return { status: "error", message: "Could not connect to eligibility service." };
    }

    // Step 2: PatientFinder
    const finderResp = await pverifyPost("/api/PatientFinderInquiry", accessToken, {
      FirstName: firstName,
      LastName: lastName,
      DOB: dobFmt,
    });

    const requestId = finderResp.RequestId;
    if (!requestId) {
      return {
        status: "not_found",
        message: "We were unable to locate your Medicare records. Could you verify the spelling of your name and date of birth?",
      };
    }

    // Step 3: Wait for pVerify to process (~4s per pVerify docs)
    await sleep(4000);

    // Step 4: Get PatientFinder result - extract SSN
    const finderResult = await pverifyGet(`/api/GetPatientFinderResponse/${requestId}`, accessToken);
    const ssn = (finderResult.Patients && finderResult.Patients[0] && finderResult.Patients[0].SSN) || null;

    // Step 5: MBI Inquiry
    const mbiResp = await pverifyPost("/api/MBIInquiry", accessToken, {
      PatientSSN: ssn,
      ProviderLastName: PROVIDER_LAST_NAME,
      ProviderNPI: PROVIDER_NPI,
      PatientFirstName: firstName,
      PatientLastName: lastName,
      PatientDOB: dobFmt,
    });

    const mbi = mbiResp.MBI || (mbiResp.Patients && mbiResp.Patients[0] && mbiResp.Patients[0].MBI) || null;

    if (!mbi) {
      return {
        status: "not_eligible",
        message: "We were unable to verify active Medicare Part B coverage for this patient at this time.",
      };
    }

    // AWV history check: pVerify claims data has 2-4 week lag and is unreliable for recent AWVs.
    // ThoroughCare has no public API. Agent asks patient directly; ops confirms before visit.
    // MBI is kept internal only — never surfaces to patient or calendar.
    return {
      status: "eligible",
      partB_active: true,
      message: "eligible",
      // mbi intentionally omitted from response — kept server-side only
      // ops_confirmation_required: true — booking is tentative until ops verifies in ThoroughCare
    };

  } catch (err) {
    console.error("Eligibility check error:", err.message);
    return {
      status: "error",
      message: "There was a temporary issue verifying eligibility. Please hold while I connect you with our team.",
    };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    return { statusCode: 200, body: JSON.stringify({ status: "ok" }) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // Parse Vapi tool call format
  const toolCallList = (body.message && body.message.toolCallList) || [];
  const toolCall = toolCallList[0] || {};
  const args = (toolCall.function && toolCall.function.arguments) || body;
  const toolCallId = toolCall.id || "unknown";

  const firstName = args.firstName || args.first_name || "";
  const lastName = args.lastName || args.last_name || "";
  const dob = args.dob || args.dateOfBirth || "";

  console.log(`Eligibility check: ${firstName} ${lastName}, DOB: ${dob}`);

  if (!firstName || !lastName || !dob) {
    const result = { status: "error", message: "I need your first name, last name, and date of birth to look up your eligibility." };
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ results: [{ toolCallId, result: JSON.stringify(result) }] }),
    };
  }

  const result = await checkEligibility(firstName, lastName, dob);
  console.log(`Result for ${firstName} ${lastName}:`, result.status);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ results: [{ toolCallId, result: JSON.stringify(result) }] }),
  };
};
