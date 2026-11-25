/**
 * appPush.js — push a notification to her phone through partner_backend
 * (POST /internal/app-notify), which holds her device token.
 *
 * Signed like every other CRM → app backend call (partner_backend
 * helper/crmSignature.js): HMAC over "<timestamp>.POST.<path+query>.<body>".
 * The shared secret itself never travels, a captured request expires after
 * 5 minutes, and it can't be re-pointed at another user.
 *
 * Secret: CRM_TO_APP_SECRET if set (set the same value on both servers to
 * give this direction its own key), else APP_WEBHOOK_SECRET.
 *
 * pushToApp({ appUserId, title, body, data }) → { pushed: boolean, reason? }
 * pushed is true only when the app backend confirms the push went out.
 * Never throws.
 */
const crypto = require("crypto");

function notifyUrl() {
  if (process.env.APP_NOTIFY_URL) return process.env.APP_NOTIFY_URL;
  const base = (process.env.PARTNER_BACKEND_URL || "").replace(/\/$/, "");
  return base ? `${base}/internal/app-notify` : null;
}

async function pushToApp({ appUserId, title, body, data } = {}) {
  const url = notifyUrl();
  const secret = process.env.CRM_TO_APP_SECRET || process.env.APP_WEBHOOK_SECRET;
  if (!appUserId || !url || !secret) return { pushed: false, reason: "not_configured" };
  if (process.env.OUTBOUND_DISABLED === "1") return { pushed: false, reason: "outbound_disabled" };

  let pathQ;
  try {
    const u = new URL(url);
    pathQ = u.pathname + u.search;
  } catch (_) {
    return { pushed: false, reason: "bad_APP_NOTIFY_URL" };
  }
  const raw = JSON.stringify({
    app_user_id: appUserId,
    title: title || "Fit Her",
    body: String(body || "").slice(0, 500),
    data: data || {},
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.POST.${pathQ}.${raw}`).digest("hex");

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-timestamp": ts,
        "x-webhook-signature": `sha256=${sig}`,
      },
      body: raw,
    });
    const json = await resp.json().catch(() => ({}));
    if (resp.ok && String(json.status) === "1") return { pushed: true };
    return { pushed: false, reason: json.message || `http_${resp.status}` };
  } catch (e) {
    return { pushed: false, reason: e.message };
  }
}

module.exports = { pushToApp, notifyUrl };
