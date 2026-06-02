// Medcare AWV Eligibility Check
// Internal use only - called by Vapi voice agent during patient calls
// Flow:
//   1. pVerify: confirm active Medicare coverage + get MBI (internal only)
//   2. ThoroughCare: search patient by name+DOB, check for G0438/G0439 procedures this year
//   3. Return: eligible + awv_completed_this_year flag

const https = require("https");
const querystring = require("querystring");

// pVerify config
const PVERIFY_BASE = "api.pverify.com";
const PVERIFY_CLIENT_ID = process.env.PVERIFY_CLIENT_ID || "811ff04a-abe0-4546-87c5-ece4288ef8e4";
const PVERIFY_CLIENT_SECRET = process.env.PVERIFY_CLIENT_SECRET || "S1KKfZSkzg6jZHUY7SgSJZmPPmjmMg";
const PROVIDER_LAST_NAME = "Rishmawi";
const PROVIDER_NPI = "1437443082";

// ThoroughCare config
const TC_BASE = "api.secure.thoroughcare.com";
const TC_CLIENT_ID = process.env.TC_CLIENT_ID;
const TC_CLIENT_SECRET = process.env.TC_CLIENT_SECRET;

// AWV CPT codes
const AWV_CODES = new Set(["G0438", "G0439", "G0468"]);

// Current calendar year
const CURRENT_YEAR = new Date().getFullYear();

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve({ body: JSON.parse(data), status: res.statusCode }); }
        catch (e) { resolve({ body: { _raw: data }, status: res.statusCode }); }
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

function normalizeDobForPverify(dob) {
  // pVerify wants MM/DD/YYYY
  const s = String(dob || "").trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  return s;
}

function normalizeDobForTC(dob) {
  // ThoroughCare wants YYYY-MM-DD
  const s = String(dob || "").trim();
  // Already ISO
  if (s.match(/^\d{4}-\d{2}-\d{2}$/)) return s;
  // MM/DD/YYYY → YYYY-MM-DD
  const mdy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1]}-${mdy[2]}`;
  return s;
}

// ─── pVerify ────────────────────────────────────────────────────────────────

async function getPverifyToken() {
  const body = querystring.stringify({
    Client_ID: PVERIFY_CLIENT_ID,
    Client_Secret: PVERIFY_CLIENT_SECRET,
    grant_type: "client_credentials",
  });
  const { body: data } = await httpsRequest({
    hostname: PVERIFY_BASE,
    path: "/Token",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
  return data.access_token || null;
}

async function pverifyPost(path, token, data) {
  const body = JSON.stringify(data);
  const { body: resp } = await httpsRequest({
    hostname: PVERIFY_BASE,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "Client-API-Id": PVERIFY_CLIENT_ID,
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
  return resp;
}

async function pverifyGet(path, token) {
  const { body: resp } = await httpsRequest({
    hostname: PVERIFY_BASE,
    path,
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Client-API-Id": PVERIFY_CLIENT_ID,
    },
  });
  return resp;
}

async function checkMedicareCoverage(firstName, lastName, dob) {
  const dobFmt = normalizeDobForPverify(dob);

  const accessToken = await getPverifyToken();
  if (!accessToken) return { covered: false, reason: "pverify_token_failed" };

  const finderResp = await pverifyPost("/api/PatientFinderInquiry", accessToken, {
    FirstName: firstName,
    LastName: lastName,
    DOB: dobFmt,
  });

  const requestId = finderResp.RequestId;
  if (!requestId) return { covered: false, reason: "not_found" };

  await sleep(4000);

  const finderResult = await pverifyGet(`/api/GetPatientFinderResponse/${requestId}`, accessToken);
  const ssn = (finderResult.Patients?.[0]?.SSN) || null;

  const mbiResp = await pverifyPost("/api/MBIInquiry", accessToken, {
    PatientSSN: ssn,
    ProviderLastName: PROVIDER_LAST_NAME,
    ProviderNPI: PROVIDER_NPI,
    PatientFirstName: firstName,
    PatientLastName: lastName,
    PatientDOB: dobFmt,
  });

  const mbi = mbiResp.MBI || mbiResp.Patients?.[0]?.MBI || null;
  if (!mbi) return { covered: false, reason: "no_mbi" };

  // MBI is confirmed but stays internal — never returned to agent
  return { covered: true };
}

// ─── ThoroughCare ───────────────────────────────────────────────────────────

async function getTCToken() {
  if (!TC_CLIENT_ID || !TC_CLIENT_SECRET) return null;
  const body = querystring.stringify({
    grant_type: "client_credentials",
    client_id: TC_CLIENT_ID,
    client_secret: TC_CLIENT_SECRET,
  });
  const { body: data } = await httpsRequest({
    hostname: TC_BASE,
    path: "/oauth/token",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
  return data.access_token || null;
}

async function tcGet(path, token) {
  const { body: data, status } = await httpsRequest({
    hostname: TC_BASE,
    path,
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    },
  });
  return { data, status };
}

async function checkAWVHistory(firstName, lastName, dob) {
  // Returns: { found: bool, awv_this_year: bool, tc_patient_id: string|null }
  try {
    const token = await getTCToken();
    if (!token) return { found: false, awv_this_year: false, tc_patient_id: null };

    const dobTC = normalizeDobForTC(dob);
    const searchPath = `/v1.3/Patient?first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&birthDate=${dobTC}&_count=5`;

    const { data: searchResp } = await tcGet(searchPath, token);
    const entries = searchResp.entry || [];
    if (!entries.length) return { found: false, awv_this_year: false, tc_patient_id: null };

    const patientId = entries[0].resource?.id;
    if (!patientId) return { found: false, awv_this_year: false, tc_patient_id: null };

    // Check procedures since Jan 1 of current year
    const sinceDate = `${CURRENT_YEAR}-01-01T00:00:00.000-05:00`;
    const procPath = `/v1.3/Procedure?patient_id=${patientId}&_lastUpdated=ge${sinceDate}&_count=50`;
    const { data: procResp } = await tcGet(procPath, token);

    const procedures = procResp.entry || [];
    let awvThisYear = false;

    for (const entry of procedures) {
      const proc = entry.resource || {};
      const codings = proc.code?.coding || [];
      const status = proc.status || "";

      // Only count completed AWVs
      if (status === "completed") {
        for (const coding of codings) {
          const code = (coding.code || "").toUpperCase();
          if (AWV_CODES.has(code)) {
            awvThisYear = true;
            break;
          }
        }
      }
      if (awvThisYear) break;
    }

    return { found: true, awv_this_year: awvThisYear, tc_patient_id: String(patientId) };

  } catch (err) {
    console.error("ThoroughCare check error:", err.message);
    // Fail open — don't block booking if TC is down
    return { found: false, awv_this_year: false, tc_patient_id: null };
  }
}

// ─── Main eligibility check ─────────────────────────────────────────────────

async function checkEligibility(firstName, lastName, dob) {
  try {
    // Run pVerify and ThoroughCare in parallel to save time
    const [coverage, awvHistory] = await Promise.all([
      checkMedicareCoverage(firstName, lastName, dob),
      checkAWVHistory(firstName, lastName, dob),
    ]);

    // Not covered by Medicare
    if (!coverage.covered) {
      if (coverage.reason === "not_found") {
        return {
          status: "not_found",
          message: "We were unable to locate your Medicare records. Could you verify the spelling of your name and date of birth?",
        };
      }
      return {
        status: "not_eligible",
        message: "We were unable to verify active Medicare coverage for you at this time. The Annual Wellness Visit is covered for patients with Medicare Part B or a Medicare Advantage plan.",
      };
    }

    // Covered — check AWV history
    if (awvHistory.awv_this_year) {
      return {
        status: "awv_completed_this_year",
        message: "awv_already_done",
        // Agent uses this to tell patient they've already had their AWV this year
        // and offer to follow up next year
      };
    }

    // Eligible and no AWV on record this year
    return {
      status: "eligible",
      partB_active: true,
      awv_this_year: false,
      tc_patient_found: awvHistory.found,
      message: "eligible",
      // MBI intentionally omitted — stays server-side only (HIPAA)
      // tc_patient_id intentionally omitted — internal use only
    };

  } catch (err) {
    console.error("Eligibility check error:", err.message);
    return {
      status: "error",
      message: "There was a temporary issue verifying eligibility. Please hold while I connect you with our team.",
    };
  }
}

// ─── Netlify handler ─────────────────────────────────────────────────────────

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
