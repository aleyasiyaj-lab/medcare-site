// Medcare AWV Eligibility Check
// Internal use only - called by Vapi voice agent during patient calls
// Flow: pVerify Token → PatientFinder → GetPatientFinderResponse → MBIInquiry

const PVERIFY_BASE = "https://api.pverify.com";
const CLIENT_ID = process.env.PVERIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.PVERIFY_CLIENT_SECRET;
const PROVIDER_LAST_NAME = "Rishmawi";
const PROVIDER_NPI = "1437443082";

function normalizeDob(dob) {
  const s = String(dob || "").trim();
  // YYYY-MM-DD → MM/DD/YYYY
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  return s;
}

async function getPverifyToken() {
  const body = new URLSearchParams({
    Client_ID: CLIENT_ID,
    Client_Secret: CLIENT_SECRET,
    grant_type: "client_credentials",
  });
  const resp = await fetch(`${PVERIFY_BASE}/Token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) throw new Error(`pVerify token error: ${resp.status}`);
  return resp.json();
}

async function pverifyPost(path, token, data) {
  const resp = await fetch(`${PVERIFY_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Client-API-Id": CLIENT_ID,
    },
    body: JSON.stringify(data),
  });
  return resp.json();
}

async function pverifyGet(path, token) {
  const resp = await fetch(`${PVERIFY_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Client-API-Id": CLIENT_ID,
    },
  });
  return resp.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkEligibility(firstName, lastName, dob) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return { status: "error", message: "Eligibility service not configured." };
  }

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
        message: "We were unable to locate your Medicare records with the name and date of birth provided. Could you verify the spelling of your name and your date of birth?",
      };
    }

    // Step 3: Wait for pVerify processing
    await sleep(4000);

    // Step 4: Get PatientFinder result
    const finderResult = await pverifyGet(`/api/GetPatientFinderResponse/${requestId}`, accessToken);
    const ssn = finderResult?.Patients?.[0]?.SSN ?? null;

    // Step 5: MBI Inquiry
    const mbiResp = await pverifyPost("/api/MBIInquiry", accessToken, {
      PatientSSN: ssn,
      ProviderLastName: PROVIDER_LAST_NAME,
      ProviderNPI: PROVIDER_NPI,
      PatientFirstName: firstName,
      PatientLastName: lastName,
      PatientDOB: dobFmt,
    });

    const mbi = mbiResp?.MBI || mbiResp?.Patients?.[0]?.MBI || null;

    if (!mbi) {
      return {
        status: "not_eligible",
        message: "We were unable to verify active Medicare Part B coverage for this patient at this time.",
      };
    }

    // Step 6: ThoroughCare AWV history check
    // TODO: Add ThoroughCare API call here once credentials are available
    // For now: return eligible, flag for manual ThoroughCare confirmation by ops team
    return {
      status: "eligible",
      mbi: mbi,
      message: "eligible",
      note: "ThoroughCare check pending manual confirmation by ops team.",
    };

  } catch (err) {
    console.error("Eligibility check error:", err);
    return {
      status: "error",
      message: "There was a temporary issue checking your eligibility. Please hold while I connect you with our team.",
    };
  }
}

export const handler = async (event) => {
  // Health check
  if (event.httpMethod === "GET") {
    return { statusCode: 200, body: JSON.stringify({ status: "ok" }) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // Parse Vapi tool call format
  const toolCallList = body?.message?.toolCallList || [];
  const toolCall = toolCallList[0] || {};
  const args = toolCall?.function?.arguments || body;
  const toolCallId = toolCall?.id || "unknown";

  const firstName = args.firstName || args.first_name || "";
  const lastName = args.lastName || args.last_name || "";
  const dob = args.dob || args.dateOfBirth || "";

  console.log(`Eligibility check: ${firstName} ${lastName}, DOB: ${dob}`);

  if (!firstName || !lastName || !dob) {
    const result = { status: "error", message: "I need your first name, last name, and date of birth to check eligibility." };
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ results: [{ toolCallId, result: JSON.stringify(result) }] }),
    };
  }

  const result = await checkEligibility(firstName, lastName, dob);
  console.log(`Result for ${firstName} ${lastName}:`, result);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ results: [{ toolCallId, result: JSON.stringify(result) }] }),
  };
};
