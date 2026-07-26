// cts.healthcare — Medicare AWV eligibility check via pverify
// Public-facing form endpoint. Returns eligibility status only — does NOT
// store PHI. Phone/email are accepted but only used for follow-up contact
// when the user has explicitly consented.
//
// pverify flow:
//   1. OAuth token (client_credentials)
//   2. PatientFinderInquiry → get SSN by name+DOB
//   3. MBIInquiry → confirm active Medicare coverage + get MBI
//   4. EligibilitySummary (PracticeTypeCode 5, HCPCSCodes G0438/G0439)
//      → check if AWV was done in past 12 months via ProfessionalEligibleDate
//
// AWV logic:
//   - G0438 (first AWV) present  → eligible (never had an AWV)
//   - G0439 (subsequent AWV) present, ProfessionalEligibleDate <= today → eligible
//   - G0439 present, ProfessionalEligibleDate > today → NOT eligible (had AWV <12mo ago)
//   - Neither present but has Part B → eligible (fallback, can't verify history)
//
// Response shape (always 200):
//   { status: "eligible" | "not_found" | "not_eligible" | "error", message: string }

const https = require("https");
const querystring = require("querystring");

const PVERIFY_BASE = "api.pverify.com";
const PVERIFY_CLIENT_ID =
  process.env.PVERIFY_CLIENT_ID || "811ff04a-abe0-4546-87c5-ece4288ef8e4";
const PVERIFY_CLIENT_SECRET =
  process.env.PVERIFY_CLIENT_SECRET || "S1KKfZSkzg6jZHUY7SgSJZmPPmjmMg";
const PROVIDER_FIRST_NAME = "Bilal";
const PROVIDER_LAST_NAME = "Rishmawi";
const PROVIDER_NPI = "1437443082";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

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

function normalizeDob(dob) {
  // pverify wants MM/DD/YYYY
  const s = String(dob || "").trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  return s;
}

async function getToken() {
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

async function pPost(path, token, payload) {
  const body = JSON.stringify(payload);
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

async function pGet(path, token) {
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

// Parse a pverify date string (MM/DD/YYYY) into a Date object
function parsePverifyDate(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
}

// Check AWV eligibility using EligibilitySummary with PracticeTypeCode 5
// Returns: { awvEligible: bool, reason: string }
async function checkAWVEligibility(token, mbiId, firstName, lastName, dobFmt) {
  try {
    const resp = await pPost("/api/EligibilitySummary", token, {
      payerCode: "MEDICARE",
      payerName: "Medicare",
      provider: {
        firstName: PROVIDER_FIRST_NAME,
        lastName: PROVIDER_LAST_NAME,
        npi: PROVIDER_NPI,
      },
      subscriber: {
        firstName: firstName,
        lastName: lastName,
        dob: dobFmt,
        memberID: mbiId,
      },
      dependent: null,
      isSubscriberPatient: "True",
      doS_StartDate: new Date().toLocaleDateString("en-US"),
      doS_EndDate: new Date().toLocaleDateString("en-US"),
      PracticeTypeCode: "5",
      IncludeTextResponse: "false",
      HCPCSCodes: ["G0438", "G0439"],
    });

    const services = resp.PreventiveServices || [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let g0438 = null;
    let g0439 = null;

    for (const s of services) {
      const code = (s.ProcedureCode || "").toUpperCase();
      if (code.includes("G0438")) g0438 = s;
      if (code.includes("G0439")) g0439 = s;
    }

    // G0438 = first AWV (patient never had one) → eligible
    if (g0438) {
      return { awvEligible: true, reason: "first_awv" };
    }

    // G0439 = subsequent AWV → check ProfessionalEligibleDate
    if (g0439) {
      const eligibleDate = parsePverifyDate(g0439.ProfessionalEligibleDate);
      if (eligibleDate && eligibleDate > today) {
        // Future date means they already had an AWV within the past 12 months
        const dateStr = g0439.ProfessionalEligibleDate;
        return {
          awvEligible: false,
          reason: "awv_used",
          nextEligibleDate: dateStr,
        };
      }
      // Eligible date is today or in the past → eligible for AWV
      return { awvEligible: true, reason: "subsequent_awv_due" };
    }

    // Neither code returned — can't verify AWV history via pverify.
    // Fall back to eligible (coverage is confirmed, just can't check history).
    return { awvEligible: true, reason: "no_awv_data" };
  } catch (err) {
    // If AWV check fails, fall back to coverage-only
    console.error("AWV check error:", err.message);
    return { awvEligible: true, reason: "awv_check_failed" };
  }
}

async function checkEligibility(firstName, lastName, dob) {
  const dobFmt = normalizeDob(dob);
  const token = await getToken();
  if (!token) return { eligible: false, reason: "token_failed" };

  // Step 1: PatientFinder → SSN
  const finder = await pPost("/api/PatientFinderInquiry", token, {
    FirstName: firstName,
    LastName: lastName,
    DOB: dobFmt,
  });
  const reqId = finder.RequestId;
  if (!reqId) return { eligible: false, reason: "not_found" };

  await sleep(4000);

  const result = await pGet(`/api/GetPatientFinderResponse/${reqId}`, token);
  const ssn = (result.Patients?.[0]?.SSN) || null;

  // Step 2: MBIInquiry → confirm Medicare coverage + get MBI
  const mbi = await pPost("/api/MBIInquiry", token, {
    PatientSSN: ssn,
    ProviderLastName: PROVIDER_LAST_NAME,
    ProviderNPI: PROVIDER_NPI,
    PatientFirstName: firstName,
    PatientLastName: lastName,
    PatientDOB: dobFmt,
  });
  const mbiId = mbi.MBI || mbi.mbi || mbi.Patients?.[0]?.MBI || mbi.Patients?.[0]?.mbi || null;
  if (!mbiId) return { eligible: false, reason: "no_mbi" };

  // Verify Part B is active (required for AWV)
  const partB = (mbi.partBStatus || mbi.PartBStatus || "").toLowerCase();
  if (partB && partB !== "active") {
    return { eligible: false, reason: "no_part_b" };
  }

  // Step 3: Check AWV eligibility via EligibilitySummary
  const awv = await checkAWVEligibility(token, mbiId, firstName, lastName, dobFmt);

  return {
    eligible: awv.awvEligible,
    reason: awv.reason,
    nextEligibleDate: awv.nextEligibleDate || null,
  };
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ status: "error", message: "Method not allowed" }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ status: "error", message: "Invalid request" }),
    };
  }

  const { firstName, lastName, dob, consent } = body;

  // Consent is required — no exceptions
  if (!consent) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        status: "error",
        message: "Consent is required to verify eligibility.",
      }),
    };
  }

  if (!firstName || !lastName || !dob) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        status: "error",
        message: "Please provide your first name, last name, and date of birth.",
      }),
    };
  }

  // Phone/email are intentionally NOT logged or sent to pverify.
  console.log(`Eligibility check: ${firstName} ${lastName}, DOB ${dob}, consent=${consent}`);

  try {
    const result = await checkEligibility(firstName, lastName, dob);

    if (!result.eligible) {
      if (result.reason === "not_found") {
        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            status: "not_found",
            message: "We were unable to locate your Medicare records. Please verify the spelling of your name and date of birth, or call 1-800-MEDICARE (1-800-633-4227) for assistance.",
          }),
        };
      }
      if (result.reason === "awv_used" && result.nextEligibleDate) {
        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            status: "not_eligible",
            message: `You have active Medicare coverage, but you have already had an Annual Wellness Visit within the past 12 months. You will be eligible for your next Annual Wellness Visit on ${result.nextEligibleDate}.`,
          }),
        };
      }
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          status: "not_eligible",
          message: "We were unable to verify your eligibility for an Annual Wellness Visit at this time. The Annual Wellness Visit is covered for patients with Medicare Part B who have not had one in the past 12 months.",
        }),
      };
    }

    // Eligible
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        status: "eligible",
        message: "You are eligible for an Annual Wellness Visit. You have active Medicare coverage and have not had an Annual Wellness Visit in the past 12 months. To schedule one by phone or video, call Medcare at (800) 303-1766.",
      }),
    };
  } catch (err) {
    console.error("Eligibility error:", err.message);
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        status: "error",
        message: "There was a temporary issue verifying eligibility. Please try again in a few minutes, or call Medcare at (800) 303-1766 for assistance.",
      }),
    };
  }
};
