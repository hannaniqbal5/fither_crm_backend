/**
 * webhookVerifier.js — HMAC-SHA256 verification for app → CRM webhooks.
 *
 * Two signing modes, both using the shared APP_WEBHOOK_SECRET:
 *
 *   v2 (recommended, used by the app backend's CRM outbox)
 *     headers: x-webhook-timestamp: <unix seconds>
 *              x-webhook-signature: sha256=<hex of HMAC(secret, "<timestamp>.<raw body>")>
 *     The timestamp must be within APP_WEBHOOK_MAX_SKEW_SEC (default 300s) of
 *     the CRM clock, so a captured request can't be replayed later.
 *
 *   legacy (body only, no timestamp) — what partner_backend's support tickets
 *     send today. Still accepted so nothing breaks during rollout. Set
 *     APP_WEBHOOK_REQUIRE_TIMESTAMP=true once every sender uses v2.
 *
 * The middleware sets req.webhookMode = "v2" | "legacy".
 */

const crypto = require("crypto");

const MAX_SKEW_SEC = parseInt(process.env.APP_WEBHOOK_MAX_SKEW_SEC, 10) || 300;

function hmacHex(secret, buf) {
  return crypto.createHmac("sha256", secret).update(buf).digest("hex");
}

function safeEqualHex(expectedHex, providedHex) {
  try {
    const a = Buffer.from(expectedHex, "hex");
    const b = Buffer.from(String(providedHex || ""), "hex");
    if (a.length === 0 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function stripPrefix(sig) {
  return sig.startsWith("sha256=") ? sig.slice("sha256=".length) : sig;
}

/**
 * verifyRequest — returns { ok, mode, reason }.
 * @param {Buffer|string} rawBody
 * @param {object} headers  lower-cased header map (Express req.headers)
 */
function verifyRequest(rawBody, headers = {}) {
  const secret = process.env.APP_WEBHOOK_SECRET;
  if (!secret) {
    console.error("❌ [appWebhook] APP_WEBHOOK_SECRET not set — cannot verify");
    return { ok: false, reason: "not_configured" };
  }
  const sigHeader = headers["x-webhook-signature"];
  if (!sigHeader || typeof sigHeader !== "string") return { ok: false, reason: "missing_signature" };
  const provided = stripPrefix(sigHeader);
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf-8");

  const tsHeader = headers["x-webhook-timestamp"];
  if (tsHeader !== undefined) {
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
    const skew = Math.abs(Date.now() / 1000 - ts);
    if (skew > MAX_SKEW_SEC) return { ok: false, reason: "timestamp_out_of_window" };
    const signed = Buffer.concat([Buffer.from(`${tsHeader}.`, "utf-8"), body]);
    return safeEqualHex(hmacHex(secret, signed), provided)
      ? { ok: true, mode: "v2" }
      : { ok: false, reason: "bad_signature" };
  }

  if (process.env.APP_WEBHOOK_REQUIRE_TIMESTAMP === "true") {
    return { ok: false, reason: "timestamp_required" };
  }
  return safeEqualHex(hmacHex(secret, body), provided)
    ? { ok: true, mode: "legacy" }
    : { ok: false, reason: "bad_signature" };
}

// Kept for any older caller: body-only check.
function verifySignature(rawBody, signatureHeader) {
  return verifyRequest(rawBody, { "x-webhook-signature": signatureHeader }).ok;
}

/**
 * Express middleware. Needs express.raw({ type: "application/json" }) on the
 * same route so req.body is the raw Buffer.
 */
function verifyAppWebhook(req, res, next) {
  const result = verifyRequest(req.body, req.headers);
  if (!result.ok) {
    console.warn(`❌ [appWebhook] rejected ${req.path}: ${result.reason}`);
    return res.status(403).json({ error: "Invalid signature", reason: result.reason });
  }
  req.webhookMode = result.mode;
  try {
    req.parsedBody = JSON.parse(req.body.toString("utf-8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  next();
}

/**
 * verifyAppRead — auth for the app backend's server-to-server READ calls
 * (GET /api/app/lead-info/:id, POST /api/app/lead-info-bulk).
 *
 * Always timestamped (no legacy mode), and the method + URL are signed too,
 * so a captured request can't be replayed later or re-pointed at another
 * user's id:
 *   headers: x-webhook-timestamp: <unix seconds>
 *            x-webhook-signature: sha256=<hex HMAC(APP_WEBHOOK_SECRET,
 *                "<timestamp>.<METHOD>.<path+query>.<raw body or empty>")>
 *
 * Needs express.raw({ type: "application/json" }) on POST routes so the raw
 * body is available; it is parsed into req.body here after verification.
 */
function verifyAppRead(req, res, next) {
  const secret = process.env.APP_WEBHOOK_SECRET;
  if (!secret) {
    console.error("❌ [appRead] APP_WEBHOOK_SECRET not set — refusing read");
    return res.status(503).json({ error: "not_configured" });
  }
  const reject = (reason) => {
    console.warn(`❌ [appRead] rejected ${req.method} ${req.originalUrl}: ${reason}`);
    return res.status(403).json({ error: "Invalid signature", reason });
  };

  const sigHeader = req.headers["x-webhook-signature"];
  const tsHeader  = req.headers["x-webhook-timestamp"];
  if (!sigHeader || typeof sigHeader !== "string") return reject("missing_signature");
  if (tsHeader === undefined) return reject("timestamp_required");
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts)) return reject("bad_timestamp");
  if (Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SEC) return reject("timestamp_out_of_window");

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const signed = Buffer.concat([
    Buffer.from(`${tsHeader}.${req.method.toUpperCase()}.${req.originalUrl}.`, "utf-8"),
    raw,
  ]);
  if (!safeEqualHex(hmacHex(secret, signed), stripPrefix(sigHeader))) return reject("bad_signature");

  if (raw.length) {
    try { req.body = JSON.parse(raw.toString("utf-8")); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  } else if (Buffer.isBuffer(req.body)) {
    req.body = {};
  }
  next();
}

module.exports = { verifyRequest, verifySignature, verifyAppWebhook, verifyAppRead };
