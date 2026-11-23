/**
 * signupRef.js — the lead id carried in a rep's app signup link (Nov 2026).
 *
 * WhatsApp-first rule: a woman who chats on WhatsApp and then signs up from
 * the rep's link must land on THAT lead, whatever phone she types. The link
 * carries `ref=<leadId>.<expiresUnix>.<sig>`; the app passes it through
 * untouched and the CRM checks its own signature when user_signup arrives.
 *
 *   make(leadId, days=30) → "123.1767225600.9f2c…"
 *   check(ref)            → leadId (number) or null (bad / expired / forged)
 */
const crypto = require("crypto");

function sig(body) {
  const secret = process.env.APP_WEBHOOK_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("APP_WEBHOOK_SECRET not set");
  return crypto.createHmac("sha256", secret).update(`signup:${body}`).digest("hex").slice(0, 32);
}

function make(leadId, days = 30) {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const body = `${parseInt(leadId, 10)}.${exp}`;
  return `${body}.${sig(body)}`;
}

function check(ref) {
  if (!ref || typeof ref !== "string") return null;
  const m = ref.trim().match(/^(\d+)\.(\d+)\.([a-f0-9]{32})$/);
  if (!m) return null;
  const body = `${m[1]}.${m[2]}`;
  let expected;
  try { expected = sig(body); } catch { return null; }
  const a = Buffer.from(expected, "hex"), b = Buffer.from(m[3], "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(m[2]) < Date.now() / 1000) return null;
  return Number(m[1]);
}

module.exports = { make, check };
