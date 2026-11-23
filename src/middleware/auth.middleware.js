/**
 * auth.middleware.js — dual-source JWT verification.
 *
 * Accepts TWO kinds of bearer tokens, in priority order:
 *
 *   1. CRM-issued JWT (signed with process.env.JWT_SECRET)
 *      Payload: { repId, role, whatsappAccountId, exp, iat }
 *      Used by: admin users (founders) logging in directly to the CRM.
 *
 *   2. partner_backend-issued JWT (signed with process.env.PARTNER_JWT_SECRET)
 *      Payload: { id, email, tv, c, iat, exp }
 *      Used by: sales reps who log in on the FitHer app backend.
 *      We then resolve the matching CRM sales_reps row via partner_user_id.
 *      Only short-lived STAFF PORTAL tokens are accepted (c = "p", 12 h,
 *      issued by /admin/login with client: "portal", which refuses app
 *      customers). App (30-day) / web (7-day) tokens and old tokens with
 *      no expiry are refused — see verifyPartnerToken().
 *
 * After successful verification, req.user is always populated as:
 *   { repId, role, whatsappAccountId, source: 'crm' | 'partner', partnerUserId? }
 *
 * Both paths load the sales_reps row (cached in-memory for 60s) and reject
 * reps whose status is not "active". The role is always taken from the DB
 * row, never from the token, so demoting/deactivating a rep takes effect
 * within the cache TTL.
 */

const jwt = require("jsonwebtoken");
const { SalesRep } = require("../../models");

const CRM_SECRET     = process.env.JWT_SECRET;
const PARTNER_SECRET = process.env.PARTNER_JWT_SECRET;

const CACHE_TTL_MS = 60 * 1000;
const repCache    = new Map(); // key: partnerUserId, value: { rep, t }
const crmRepCache = new Map(); // key: repId,         value: { rep, t }

function tryVerify(token, secret) {
  if (!secret) return null;
  try {
    return jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}

// Which partner_backend token kinds may open the CRM. Default: staff portal
// only ("p"). Comma list, e.g. PARTNER_ALLOWED_CLIENTS=p,w to also allow web.
const PARTNER_ALLOWED_CLIENTS = String(process.env.PARTNER_ALLOWED_CLIENTS || "p")
  .split(",").map((x) => x.trim()).filter(Boolean);

/**
 * verifyPartnerToken — checks a partner_backend JWT for CRM use.
 * Returns { payload } or { reason } (never throws).
 *   - signature + expiry (HS256, PARTNER_JWT_SECRET)
 *   - must HAVE an expiry: pre-Oct-2026 tokens without one never die
 *     (escape hatch: PARTNER_ALLOW_LEGACY_TOKENS=true, temporary only)
 *   - must be a staff portal token (c in PARTNER_ALLOWED_CLIENTS)
 */
function verifyPartnerToken(token) {
  if (!PARTNER_SECRET) return { reason: "not_configured" };
  let payload;
  try {
    payload = jwt.verify(token, PARTNER_SECRET, { algorithms: ["HS256"] });
  } catch (e) {
    return { reason: e && e.name === "TokenExpiredError" ? "expired" : "invalid" };
  }
  if (!payload || payload.id == null) return { reason: "invalid" };
  if (payload.exp == null && process.env.PARTNER_ALLOW_LEGACY_TOKENS !== "true") {
    return { reason: "legacy_no_expiry" };
  }
  if (payload.exp != null && !PARTNER_ALLOWED_CLIENTS.includes(payload.c)) {
    return { reason: "not_portal_token" };
  }
  return { payload };
}

async function resolveRepFromPartnerId(partnerUserId) {
  const cached = repCache.get(partnerUserId);
  if (cached && Date.now() - cached.t < CACHE_TTL_MS) {
    return cached.rep;
  }
  const rep = await SalesRep.findOne({ where: { partner_user_id: partnerUserId } });
  if (rep) repCache.set(partnerUserId, { rep, t: Date.now() });
  return rep;
}

async function resolveRepById(repId) {
  const cached = crmRepCache.get(repId);
  if (cached && Date.now() - cached.t < CACHE_TTL_MS) {
    return cached.rep;
  }
  const rep = await SalesRep.findByPk(repId);
  if (rep) crmRepCache.set(repId, { rep, t: Date.now() });
  return rep;
}

function isActiveRep(rep) {
  return !!rep && rep.status === "active";
}

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : authHeader.trim();

    // ── Path 1: CRM-native JWT (admin path) ──
    const crmDecoded = tryVerify(token, CRM_SECRET);
    if (crmDecoded && crmDecoded.repId) {
      const rep = await resolveRepById(crmDecoded.repId);
      if (!rep) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (!isActiveRep(rep)) {
        return res.status(403).json({ error: "Account is inactive. Contact admin." });
      }
      req.user = {
        repId:             crmDecoded.repId,
        role:              rep.role || "rep", // from DB, not the token
        whatsappAccountId: crmDecoded.whatsappAccountId,
        source:            "crm",
      };
      req.whatsappAccountId = crmDecoded.whatsappAccountId;
      return next();
    }

    // ── Path 2: partner_backend JWT (sales rep path) ──
    const partnerCheck = verifyPartnerToken(token);
    if (partnerCheck.reason && partnerCheck.reason !== "invalid" && partnerCheck.reason !== "not_configured") {
      // Right signature, but expired / old / not a portal login → log in again.
      return res.status(401).json({ error: "Session expired — please log in again.", reason: partnerCheck.reason });
    }
    const partnerDecoded = partnerCheck.payload;
    if (partnerDecoded && partnerDecoded.id) {
      const rep = await resolveRepFromPartnerId(partnerDecoded.id);
      if (!rep) {
        console.warn(`⚠️  [Auth] partner_user_id=${partnerDecoded.id} has no linked CRM sales_reps row`);
        return res.status(403).json({
          error: "Account not provisioned for CRM access. Contact admin.",
        });
      }
      if (!isActiveRep(rep)) {
        return res.status(403).json({ error: "Account is inactive. Contact admin." });
      }
      req.user = {
        repId:             rep.id,
        role:              rep.role || "rep",
        whatsappAccountId: rep.whatsapp_account_id,
        source:            "partner",
        partnerUserId:     partnerDecoded.id,
      };
      req.whatsappAccountId = rep.whatsapp_account_id;
      return next();
    }

    // ── Neither secret worked ──
    return res.status(401).json({ error: "Unauthorized — invalid token" });
  } catch (err) {
    console.error("❌ Auth error:", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }
};

// Allow other parts of the app to invalidate the cache (e.g. after rep update).
module.exports.invalidateRepCache = (partnerUserId) => {
  if (partnerUserId == null) { repCache.clear(); crmRepCache.clear(); }
  else repCache.delete(partnerUserId);
};

// Shared with the socket auth in App.js.
module.exports.resolveRepById          = resolveRepById;
module.exports.resolveRepFromPartnerId = resolveRepFromPartnerId;
module.exports.verifyPartnerToken = verifyPartnerToken;
module.exports.isActiveRep             = isActiveRep;
