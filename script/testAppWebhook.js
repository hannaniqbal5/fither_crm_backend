/**
 * testAppWebhook.js — sends signed test events to the local CRM, the same
 * way the app backend's outbox will. Uses a fake app user, so no real
 * customer is touched.
 *
 *   node script/testAppWebhook.js            (CRM at http://localhost:4000)
 *   node script/testAppWebhook.js http://localhost:4000
 */
require("dotenv").config();
const crypto = require("crypto");

const BASE = process.argv[2] || "http://localhost:4000";
const SECRET = process.env.APP_WEBHOOK_SECRET;
if (!SECRET) { console.error("APP_WEBHOOK_SECRET missing in .env"); process.exit(1); }

const runId = Date.now();
const user = { app_user_id: `test-${runId}`, phone: null, email: `test-${runId}@example.test`, name: "Webhook Test" };

async function send(label, body, { ts = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const raw = JSON.stringify(body);
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  try {
    const r = await fetch(`${BASE}/api/webhooks/app/event`, {
      method: "POST",
      body: raw,
      headers: { "Content-Type": "application/json", "x-webhook-timestamp": String(ts), "x-webhook-signature": sig },
    });
    const text = await r.text();
    console.log(`${label.padEnd(38)} → ${r.status} ${text}`);
  } catch (e) {
    console.log(`${label.padEnd(38)} → ERROR ${e.message} (is the backend running?)`);
  }
}

(async () => {
  const t = (h) => new Date(Date.UTC(2026, 10, 9, h)).toISOString();
  await send("1. signup (expect 200 processed)", { event_type: "user_signup", external_event_id: `su-${runId}`, payload: { ...user, occurred_at: t(8) } });
  await send("2. same signup again (expect duplicate)", { event_type: "user_signup", external_event_id: `su-${runId}`, payload: { ...user, occurred_at: t(8) } });
  await send("3. payment (expect 200 processed)", { event_type: "payment_success", external_event_id: `pay-${runId}`, payload: { ...user, plan_title: "Test plan", amount: 1, currency: "PKR", occurred_at: t(10) } });
  await send("4. older trial event (expect stale)", { event_type: "subscription_started", external_event_id: `old-${runId}`, payload: { ...user, plan_title: "Old", occurred_at: t(9) } });
  await send("5. no event id (expect 400)", { event_type: "user_login", payload: { ...user } });
  await send("6. replayed old request (expect 403)", { event_type: "user_login", external_event_id: `rp-${runId}`, payload: user }, { ts: Math.floor(Date.now() / 1000) - 3600 });
  await send("7. wrong secret (expect 403)", { event_type: "user_login", external_event_id: `ws-${runId}`, payload: user }, { secret: "wrong" });
  console.log(`\nTest lead email: ${user.email}  (delete it from leads when done if you like)`);
})();
