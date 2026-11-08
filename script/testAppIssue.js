/**
 * testAppIssue.js — fire a signed `support_issue` webhook at the CRM, exactly
 * like partner_backend would. Lets you verify the CRM side (handler → admin
 * conversation) without the app.
 *
 * Usage:
 *   node script/testAppIssue.js
 *   node script/testAppIssue.js "Custom message here"
 *
 * Reads APP_WEBHOOK_SECRET from .env. Posts to localhost:<PORT or 4000>.
 */
require("dotenv").config();
const crypto = require("crypto");

const secret = process.env.APP_WEBHOOK_SECRET;
if (!secret) {
  console.error("❌ APP_WEBHOOK_SECRET is not set in .env — set it (and restart the CRM) first.");
  process.exit(1);
}

const port = process.env.PORT || 4000;
const url = process.env.CRM_SELF_URL || `http://localhost:${port}/api/webhooks/app/event`;

const message =
  process.argv[2] || "TEST: my diet plan won't load after payment 🙏";

const payload = {
  app_user_id: "test-" + Date.now(),
  message,
  category: "APP_ISSUE",
  priority: "high",
  name: "Test User",
  phone: "923000000000",
  external_event_id: "test_" + Date.now(),
};

const raw = JSON.stringify({ event_type: "support_issue", payload });
const signature =
  "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");

(async () => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": signature,
      },
      body: raw,
    });
    const text = await res.text();
    console.log(`→ POST ${url}`);
    console.log(`← ${res.status} ${res.statusText}`);
    console.log(text);
    console.log(
      res.status === 202
        ? "\n✅ Accepted. Open the admin dashboard → Leads/Conversations — a 'Test User' lead should appear at the top (escalated)."
        : "\n⚠️  Unexpected status. 403 = secret mismatch; 400 = bad body; connection error = CRM not running on that port."
    );
  } catch (err) {
    console.error("❌ Request failed:", err.message);
    console.error("   Is the CRM running, and is the port correct? Set CRM_SELF_URL in .env to override.");
  }
})();
