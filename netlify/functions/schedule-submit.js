// Medcare Schedule Form Handler
// Sends patient confirmation email from outreach@medcaretelehealth.org via ImprovMX SMTP
// Also sends notification to outreach@ and forwards to Google Sheets

const nodemailer = require("nodemailer");
const https = require("https");

const SMTP_USER = "sender@medcaretelehealth.org";
const SMTP_PASS = "Med494591b4cdbaa146e47ff437!";
const FROM_EMAIL = "outreach@medcaretelehealth.org";
const GOOGLE_SHEET_WEBHOOK = "https://script.google.com/macros/s/AKfycbwMscDdI_An0kJZffw4ixm7xX-XNoiex_R83VnQ-DiCeegjQuFcmpFTgYi5oQ9HNhOHtg/exec";

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: "smtp.improvmx.com",
      port: 587,
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

function forwardToGoogleSheets(data) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(data);
    const options = {
      hostname: "script.google.com",
      path: "/macros/s/AKfycbwMscDdI_An0kJZffw4ixm7xX-XNoiex_R83VnQ-DiCeegjQuFcmpFTgYi5oQ9HNhOHtg/exec",
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const firstName = (data.firstName || "").trim();
  const lastName = (data.lastName || "").trim();
  const dob = (data.dob || "").trim();
  const phone = (data.phone || "").trim();
  const email = (data.email || "").trim().toLowerCase();
  const preferredDate = data.preferredDate || "";
  const preferredTime = data.preferredTime || "";

  if (!firstName || !lastName || !email) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Missing required fields" }),
    };
  }

  // Patient confirmation email
  const patientSubject = "Your Medcare Telehealth Appointment Confirmation";
  const patientText = "Dear " + firstName + ",\n\nThank you for scheduling your visit with Medcare Telehealth. Here are your appointment details:\n\nName: " + firstName + " " + lastName + "\nPreferred Date: " + preferredDate + "\nPreferred Time: " + preferredTime + "\n\nOur team will contact you shortly to confirm your appointment. If you need to make any changes, please call us at (800) 303-1766.\n\nWhat to expect:\n- A licensed clinician will conduct your Annual Wellness Visit by phone or secure video\n- The visit is generally at no cost for eligible Medicare patients\n- During the visit, the clinician may identify if you could benefit from additional services\n\nWe look forward to speaking with you.\n\nMedcare Telehealth\n(800) 303-1766\nmedcaretelehealth.org";

  const patientHtml = "<html><body style=\"font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;\"><h2 style=\"color:#0d7553;\">Your appointment is scheduled!</h2><p>Dear " + firstName + ",</p><p>Thank you for scheduling your visit with Medcare Telehealth. Here are your appointment details:</p><table style=\"border-collapse:collapse;width:100%;margin:20px 0;\"><tr><td style=\"padding:8px;border:1px solid #e2e8f0;font-weight:600;\">Name</td><td style=\"padding:8px;border:1px solid #e2e8f0;\">" + firstName + " " + lastName + "</td></tr><tr><td style=\"padding:8px;border:1px solid #e2e8f0;font-weight:600;\">Preferred Date</td><td style=\"padding:8px;border:1px solid #e2e8f0;\">" + preferredDate + "</td></tr><tr><td style=\"padding:8px;border:1px solid #e2e8f0;font-weight:600;\">Preferred Time</td><td style=\"padding:8px;border:1px solid #e2e8f0;\">" + preferredTime + "</td></tr></table><p>Our team will contact you shortly to confirm your appointment. If you need to make any changes, please call us at (800) 303-1766.</p><h3 style=\"color:#0d7553;\">What to expect</h3><ul><li>A licensed clinician will conduct your Annual Wellness Visit by phone or secure video</li><li>The visit is generally at no cost for eligible Medicare patients</li><li>During the visit, the clinician may identify if you could benefit from additional services</li></ul><p>We look forward to speaking with you.</p><p style=\"color:#64748b;border-top:1px solid #e2e8f0;padding-top:16px;margin-top:24px;\">Medcare Telehealth<br>(800) 303-1766<br>medcaretelehealth.org</p></body></html>";

  // Notification email for the clinic
  const notifySubject = "New Appointment Scheduled: " + firstName + " " + lastName;
  const notifyText = "New appointment scheduled on medcaretelehealth.org\n\nName: " + firstName + " " + lastName + "\nDate of Birth: " + dob + "\nPhone: " + phone + "\nEmail: " + email + "\nPreferred Date: " + preferredDate + "\nPreferred Time: " + preferredTime + "\n\nPlease contact the patient to confirm the appointment.";

  const notifyHtml = "<html><body style=\"font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;\"><h2 style=\"color:#0d7553;\">New Appointment Scheduled</h2><table style=\"border-collapse:collapse;width:100%;margin:20px 0;\"><tr><td style=\"padding:8px;border:1px solid #e2e8f0;font-weight:600;\">Name</td><td style=\"padding:8px;border:1px solid #e2e8f0;\">" + firstName + " " + lastName + "</td></tr><tr><td style=\"padding:8px;border:1px solid #e2e8f0;font-weight:600;\">Date of Birth</td><td style=\"padding:8px;border:1px solid #e2e8f0;\">" + dob + "</td></tr><tr><td style=\"padding:8px;border:1px solid #e2e8f0;font-weight:600;\">Phone</td><td style=\"padding:8px;border:1px solid #e2e8f0;\">" + phone + "</td></tr><tr><td style=\"padding:8px;border:1px solid #e2e8f0;font-weight:600;\">Email</td><td style=\"padding:8px;border:1px solid #e2e8f0;\">" + email + "</td></tr><tr><td style=\"padding:8px;border:1px solid #e2e8f0;font-weight:600;\">Preferred Date</td><td style=\"padding:8px;border:1px solid #e2e8f0;\">" + preferredDate + "</td></tr><tr><td style=\"padding:8px;border:1px solid #e2e8f0;font-weight:600;\">Preferred Time</td><td style=\"padding:8px;border:1px solid #e2e8f0;\">" + preferredTime + "</td></tr></table><p style=\"color:#64748b;\">Please contact the patient to confirm the appointment.</p><p style=\"color:#64748b;font-size:0.85rem;\">Scheduled via medcaretelehealth.org/schedule/</p></body></html>";

  const results = { patientEmail: false, notifyEmail: false, googleSheet: false };
  const t = getTransporter();

  // Send patient confirmation email
  try {
    await t.sendMail({
      from: "Medcare Telehealth <" + FROM_EMAIL + ">",
      to: email,
      subject: patientSubject,
      text: patientText,
      html: patientHtml,
      replyTo: FROM_EMAIL,
    });
    results.patientEmail = true;
  } catch (err) {
    console.error("Patient email error:", err.message);
  }

  // Send notification email to outreach@
  try {
    await t.sendMail({
      from: "Medcare Telehealth <" + FROM_EMAIL + ">",
      to: FROM_EMAIL,
      subject: notifySubject,
      text: notifyText,
      html: notifyHtml,
    });
    results.notifyEmail = true;
  } catch (err) {
    console.error("Notification email error:", err.message);
  }

  // Forward to Google Sheets
  try {
    await forwardToGoogleSheets(data);
    results.googleSheet = true;
  } catch (err) {
    console.error("Google Sheets error:", err.message);
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ status: "success", ...results }),
  };
};
