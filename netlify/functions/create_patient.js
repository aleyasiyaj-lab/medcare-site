// Medcare - Create Patient in ThoroughCare
// Internal use only - called by Vapi after eligibility confirms new patient
// Flow:
//   1. Re-fetch MBI from pVerify (stateless - no shared state with eligibility function)
//   2. Create Patient in ThoroughCare with name, DOB, gender, phone, AWV program flag
//   3. Create Coverage record with MBI stored as Medicare subscriber ID
//   4. Return ThoroughCare patient ID

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
const TC_FL_ORG_ID = "3652"; // Medcare Telehealth Inc. - Florida

// ─── HTTP helpers ────────────────────────────────────────────────────────────

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
  const s = String(dob || "").trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  return s;
}

function normalizeDobForTC(dob) {
  const s = String(dob || "").trim();
  if (s.match(/^\d{4}-\d{2}-\d{2}$/)) return s;
  const mdy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1]}-${mdy[2]}`;
  return s;
}

function normalizeGender(gender) {
  const g = String(gender || "").toLowerCase().trim();
  if (g === "male" || g === "m" || g === "man") return "male";
  if (g === "female" || g === "f" || g === "woman") return "female";
  return "male"; // fallback - ops can correct
}

function normalizePhone(phone) {
  // Normalize to E.164 format (+1XXXXXXXXXX)
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone; // return as-is if can't normalize
}

// ─── pVerify MBI fetch ───────────────────────────────────────────────────────

async function getMBI(firstName, lastName, dob) {
  const dobFmt = normalizeDobForPverify(dob);

  const tokenBody = querystring.stringify({
    Client_ID: PVERIFY_CLIENT_ID,
    Client_Secret: PVERIFY_CLIENT_SECRET,
    grant_type: "client_credentials",
  });
  const { body: tokenData } = await httpsRequest({
    hostname: PVERIFY_BASE,
    path: "/Token",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(tokenBody),
    },
  }, tokenBody);

  const accessToken = tokenData.access_token;
  if (!accessToken) return null;

  const finderBody = JSON.stringify({ FirstName: firstName, LastName: lastName, DOB: dobFmt });
  const { body: finderResp } = await httpsRequest({
    hostname: PVERIFY_BASE,
    path: "/api/PatientFinderInquiry",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "Client-API-Id": PVERIFY_CLIENT_ID,
      "Content-Length": Buffer.byteLength(finderBody),
    },
  }, finderBody);

  const requestId = finderResp.RequestId;
  if (!requestId) return null;

  await sleep(4000);

  const { body: finderResult } = await httpsRequest({
    hostname: PVERIFY_BASE,
    path: `/api/GetPatientFinderResponse/${requestId}`,
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Client-API-Id": PVERIFY_CLIENT_ID,
    },
  });

  const ssn = finderResult.Patients?.[0]?.SSN || null;

  const mbiBody = JSON.stringify({
    PatientSSN: ssn,
    ProviderLastName: PROVIDER_LAST_NAME,
    ProviderNPI: PROVIDER_NPI,
    PatientFirstName: firstName,
    PatientLastName: lastName,
    PatientDOB: dobFmt,
  });
  const { body: mbiResp } = await httpsRequest({
    hostname: PVERIFY_BASE,
    path: "/api/MBIInquiry",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "Client-API-Id": PVERIFY_CLIENT_ID,
      "Content-Length": Buffer.byteLength(mbiBody),
    },
  }, mbiBody);

  return mbiResp.MBI || mbiResp.Patients?.[0]?.MBI || null;
}

// ─── ThoroughCare ─────────────────────────────────────────────────────────────

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

async function tcPost(path, token, payload) {
  const body = JSON.stringify(payload);
  return httpsRequest({
    hostname: TC_BASE,
    path,
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
}

async function createTCPatient(token, firstName, lastName, dob, gender, phone) {
  const payload = {
    resourceType: "Patient",
    managingOrganization: { reference: `Organization/${TC_FL_ORG_ID}` },
    name: [{ use: "official", family: lastName, given: [firstName] }],
    gender: normalizeGender(gender),
    birthDate: normalizeDobForTC(dob),
    telecom: phone ? [{ system: "phone", value: normalizePhone(phone), use: "mobile" }] : [],
    extension: [
      { url: "eligible-programs", value: ["awv"] }
    ],
  };

  const { body, status } = await tcPost("/v1.3/Patient", token, payload);
  if (status !== 200 && status !== 201) {
    console.error("TC patient creation failed:", status, JSON.stringify(body));
    return null;
  }
  return body.id ? String(body.id) : null;
}

async function createTCCoverage(token, patientId, mbi) {
  if (!mbi) return false;
  const payload = {
    resourceType: "Coverage",
    beneficiary: { reference: `Patient/${patientId}` },
    status: "active",
    identifier: [{ use: "official", system: "insurance-name", value: "Medicare" }],
    subscriberId: [{ use: "official", system: "policy-id", value: mbi }],
  };
  const { status } = await tcPost("/v1.3/Coverage", token, payload);
  return status === 200 || status === 201;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function createPatient(firstName, lastName, dob, gender, phone) {
  try {
    // Run MBI fetch and TC token acquisition in parallel
    const [mbi, tcToken] = await Promise.all([
      getMBI(firstName, lastName, dob),
      getTCToken(),
    ]);

    if (!tcToken) {
      return { status: "error", message: "Could not connect to patient record system." };
    }

    // Create patient in ThoroughCare
    const patientId = await createTCPatient(tcToken, firstName, lastName, dob, gender, phone);
    if (!patientId) {
      return { status: "error", message: "Could not create patient record at this time." };
    }

    // Attach Medicare coverage with MBI
    if (mbi) {
      await createTCCoverage(tcToken, patientId, mbi);
    }

    console.log(`Created TC patient ${patientId} for ${firstName} ${lastName}, MBI: ${mbi ? "stored" : "not found"}`);

    return {
      status: "created",
      tc_patient_id: patientId,
      mbi_stored: !!mbi,
      message: "Patient record created successfully.",
    };

  } catch (err) {
    console.error("Create patient error:", err.message);
    return { status: "error", message: "There was a temporary issue creating the patient record. Your appointment will still be scheduled." };
  }
}

// ─── Netlify handler ──────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    return { statusCode: 200, body: JSON.stringify({ status: "ok" }) };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return { statusCode: 400, body: "Invalid JSON" }; }

  // Parse Vapi tool call format
  const toolCallList = (body.message && body.message.toolCallList) || [];
  const toolCall = toolCallList[0] || {};
  const args = (toolCall.function && toolCall.function.arguments) || body;
  const toolCallId = toolCall.id || "unknown";

  const firstName = args.firstName || args.first_name || "";
  const lastName = args.lastName || args.last_name || "";
  const dob = args.dob || args.dateOfBirth || "";
  const gender = args.gender || "";
  const phone = args.phone || args.phoneNumber || "";

  console.log(`Create patient: ${firstName} ${lastName}, DOB: ${dob}, gender: ${gender}`);

  if (!firstName || !lastName || !dob || !gender) {
    const result = { status: "error", message: "Missing required fields to create patient record." };
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ results: [{ toolCallId, result: JSON.stringify(result) }] }),
    };
  }

  const result = await createPatient(firstName, lastName, dob, gender, phone);
  console.log(`Create patient result for ${firstName} ${lastName}:`, result.status);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ results: [{ toolCallId, result: JSON.stringify(result) }] }),
  };
};
