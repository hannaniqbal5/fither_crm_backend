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
 *      Payload: { id, email }
 *      Used by: sales reps who log in on the FitHer app backend.
 *      We then resolve the matching CRM sales_reps row via partner_user_id.
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
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
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
    const partnerDecoded = tryVerify(token, PARTNER_SECRET);
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
module.exports.isActiveRep             = isActiveRep;
