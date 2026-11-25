/**
 * partnerSigned.js — signed server-to-server calls from the CRM to
 * partner_backend's /internal/crm/* routes (Nov 2026).
 *
 *   x-webhook-timestamp: <unix s>
 *   x-webhook-signature: sha256=HMAC(APP_WEBHOOK_SECRET,
 *                          "<ts>.<METHOD>.<path+query>.<JSON body or empty>")
 * (partner_backend helper/crmSignature.js checks it.)
 *
 * partnerCall(method, path, bodyObj) → the response's `data`, or throws an
 * Error with .status (503 not configured, 502 partner refused / down) and
 * the partner's own message.
 */
const crypto = require("crypto");

const PARTNER_URL = () => (process.env.PARTNER_BACKEND_URL || "http://localhost:9000").replace(/\/$/, "");

async function partnerCall(method, path, bodyObj) {
  // CRM_TO_APP_SECRET gives this direction its own key (same value on both
  // servers); until it is set, the shared APP_WEBHOOK_SECRET is used.
  const secret = process.env.CRM_TO_APP_SECRET || process.env.APP_WEBHOOK_SECRET;
  if (!secret) throw Object.assign(new Error("APP_WEBHOOK_SECRET not set"), { status: 503 });
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${method}.${path}.${body}`).digest("hex");
  let resp;
  try {
    resp = await fetch(PARTNER_URL() + path, {
      method,
      headers: { "Content-Type": "application/json", "x-webhook-timestamp": ts, "x-webhook-signature": `sha256=${sig}` },
      body: body || undefined,
    });
  } catch (e) {
    throw Object.assign(new Error(`App backend not reachable: ${e.message}`), { status: 502 });
  }
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || String(json.status) !== "1") {
    throw Object.assign(new Error(json.message || `App backend error ${resp.status}`), { status: 502 });
  }
  return json.data || {};
}

module.exports = { partnerCall };
