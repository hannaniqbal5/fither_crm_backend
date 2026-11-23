/**
 * paymentLink.routes.js — create a payment (magic) link for a lead (Nov 2026).
 *
 * POST /api/leads/:leadId/payment-link
 *   Body: { PlanId, PriceDurationId, listPrice, paidAmount, discountReason?,
 *           payerName?, payerRelationship?, validDays?, notes? }
 *   → partner_backend POST /internal/crm/magic-links (signed, see
 *     services/partnerSigned.js) → { status: "1", data: { url, token, expiresAt, ... } }
 *
 * Replaces the dashboard calling partner_backend directly with the rep's own
 * token, which failed for every rep who logs in with a CRM password. The
 * link is still credited to the rep (her partner user id is sent when known).
 */
const express = require("express");
const auth = require("../middleware/auth.middleware");
const { People, SalesRep } = require("../../models");
const { assertOwnsOr403 } = require("../middleware/leadOwnership");
const { partnerCall } = require("../services/partnerSigned");

const router = express.Router();

const PASS = ["PlanId", "PriceDurationId", "listPrice", "paidAmount", "discountReason",
  "payerName", "payerRelationship", "validDays", "notes"];

router.post("/:leadId/payment-link", auth, async (req, res) => {
  try {
    const lead = await People.findByPk(req.params.leadId);
    if (!lead) return res.status(404).json({ status: "0", message: "Lead not found" });
    if (!assertOwnsOr403(req, res, lead)) return;

    const body = {};
    for (const k of PASS) if (req.body?.[k] !== undefined) body[k] = req.body[k];
    body.phone = lead.phone || null;
    body.crmLeadId = lead.id;
    const rep = await SalesRep.findByPk(req.user.repId, { attributes: ["id", "name", "partner_user_id"] }).catch(() => null);
    if (rep?.partner_user_id) body.partner_user_id = rep.partner_user_id;
    if (rep?.name) body.agent_name = rep.name;

    const data = await partnerCall("POST", "/internal/crm/magic-links", body);
    return res.json({ status: "1", message: "Link created", data });
  } catch (e) {
    console.error("[payment-link]", e.message);
    return res.status(e.status || 500).json({ status: "0", message: e.message });
  }
});

module.exports = router;
