/**
 * mediaUrl.js — signed, expiring links for /uploads (customer voice notes,
 * photos, documents, campaign media).
 *
 * Two kinds of access:
 *   • signed link   /uploads/x.jpg?exp=<unix s>&sig=<hmac>   — for WhatsApp /
 *     Meta servers that fetch campaign media, or any link handed out by the
 *     server. publicUrl() makes one (1 hour).
 *   • media token   ?t=<repId.exp.hmac>                       — for the
 *     dashboard's <img>/<audio>/<video> tags, which can't send a login
 *     header. Issued to a logged-in rep/admin by GET /api/media-token (12 h).
 *
 * UPLOADS_ACCESS=signed makes /uploads refuse anything else. Default "open"
 * only logs unsigned requests, so the dashboard can be deployed first.
 * Secret: MEDIA_URL_SECRET, else JWT_SECRET.
 */
const crypto = require("crypto");

const secret = () => process.env.MEDIA_URL_SECRET || process.env.JWT_SECRET || "";
const hmac = (s) => crypto.createHmac("sha256", secret()).update(s).digest("hex").slice(0, 32);
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const nowS = () => Math.floor(Date.now() / 1000);

/** "/uploads/x.jpg" (no query) → "/uploads/x.jpg?exp=…&sig=…" */
function signPath(path, ttlSec = 3600) {
  const exp = nowS() + ttlSec;
  return `${path}?exp=${exp}&sig=${hmac(`${path}|${exp}`)}`;
}
function verifySigned(path, exp, sig) {
  if (!secret() || !exp || !sig || Number(exp) < nowS()) return false;
  return safeEq(hmac(`${path}|${Number(exp)}`), sig);
}

function issueMediaToken(repId, ttlSec = 12 * 3600) {
  const exp = nowS() + ttlSec;
  const body = `${repId}.${exp}`;
  return { token: `${body}.${hmac(`media|${body}`)}`, expires_at: new Date(exp * 1000).toISOString() };
}
function verifyMediaToken(token) {
  const m = /^(\d+)\.(\d+)\.([0-9a-f]{32})$/.exec(String(token || ""));
  if (!m || !secret() || Number(m[2]) < nowS()) return null;
  return safeEq(hmac(`media|${m[1]}.${m[2]}`), m[3]) ? { repId: Number(m[1]) } : null;
}

/**
 * Absolute URL for media the server sends out (WhatsApp / Instagram /
 * Facebook fetch it themselves). Our own /uploads files get a 1-hour signed
 * link; anything else (https://…) is returned unchanged.
 */
function publicUrl(mediaUrl, ttlSec = 3600) {
  if (!mediaUrl || /^https?:\/\//i.test(mediaUrl)) return mediaUrl;
  const base = (process.env.BASE_URL || "http://localhost:4000").replace(/\/$/, "");
  const path = mediaUrl.startsWith("/") ? mediaUrl : `/${mediaUrl}`;
  return base + (path.startsWith("/uploads/") ? signPath(path.split("?")[0], ttlSec) : path);
}

/** Express middleware for app.use("/uploads", …). */
let lastWarn = 0;
function uploadsGuard(req, res, next) {
  let path;
  try { path = "/uploads" + decodeURIComponent(req.path); } catch (_) { return res.status(400).end(); }
  if (verifySigned(path, req.query.exp, req.query.sig) || verifyMediaToken(req.query.t)) return next();
  if (process.env.UPLOADS_ACCESS === "signed") {
    return res.status(403).json({ error: "This file link has expired or isn't signed. Reload the page." });
  }
  if (Date.now() - lastWarn > 60 * 60 * 1000) {
    lastWarn = Date.now();
    console.warn(`[uploads] unsigned request allowed (${path}). Set UPLOADS_ACCESS=signed once the dashboard sends media tokens.`);
  }
  return next();
}

module.exports = { signPath, verifySigned, issueMediaToken, verifyMediaToken, publicUrl, uploadsGuard };
