/**
 * webhookVerifier.js — HMAC-SHA256 signature verification for app→CRM webhooks.
 *
 * The FitHer app backend signs every webhook payload with the shared
 * APP_WEBHOOK_SECRET, sending the signature in the `x-webhook-signature` header
 * as `sha256=<hex>`. Same pattern as Meta webhooks.
 *
 * Usage as Express middleware (with raw body capture):
 *   router.post("/webhook", express.raw({type:"application/json"}), verifyAppWebhook, handler);
 *
 * Or as a function call:
 *   if (!verifySignature(rawBody, headers["x-webhook-signature"])) ...
 */

const crypto = require("crypto");

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== "string") return false;

  const secret = process.env.APP_WEBHOOK_SECRET;
  if (!secret) {
    console.error("❌ [appWebhook] APP_WEBHOOK_SECRET not set — cannot verify");
    return false;
  }

  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(provided, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Express middleware. Requires `express.raw({ type: 'application/json' })`
 * to be applied to the same route so req.body is a Buffer.
 */
function verifyAppWebhook(req, res, next) {
  const sig = req.headers["x-webhook-signature"];
  if (!verifySignature(req.body, sig)) {
    console.warn(`❌ [appWebhook] Signature invalid for ${req.path}`);
    return res.status(403).json({ error: "Invalid signature" });
  }

  // Parse JSON body now that signature is verified
  try {
    req.parsedBody = JSON.parse(req.body.toString("utf-8"));
  } catch (err) {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  next();
}

module.exports = { verifySignature, verifyAppWebhook };
