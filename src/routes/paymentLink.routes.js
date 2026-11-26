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

const PASS = ["email", "PlanId", "PriceDurationId", "listPrice", "paidAmount", "discountReason",
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

// ── WhatsApp payments (Nov 2026): services/paymentRequest.service.js ──
//   POST /api/leads/:leadId/payment-request              { PlanId, PriceDurationId, listPrice, paidAmount,
//                                                          discountReason?, plan_title, duration_label, currency?, validDays? }
//        → sends her the amount + our accounts on WhatsApp
//   GET  /api/leads/:leadId/payment-requests             her requests (latest first)
//   POST /api/leads/:leadId/payment-requests/:id/check   { message_id } — rep: "check this photo as her slip"
//   POST /api/leads/:leadId/payment-requests/:id/cancel
const payments = require("../services/paymentRequest.service");

async function ownedLead(req, res) {
  const lead = await People.findByPk(req.params.leadId);
  if (!lead) { res.status(404).json({ status: "0", message: "Lead not found" }); return null; }
  if (!assertOwnsOr403(req, res, lead)) return null;
  return lead;
}

router.post("/:leadId/payment-request", auth, async (req, res) => {
  try {
    const lead = await ownedLead(req, res);
    if (!lead) return;
    const b = req.body || {};
    if (!b.PlanId || !b.PriceDurationId || !(Number(b.paidAmount) > 0)) {
      return res.status(400).json({ status: "0", message: "Pick a plan, duration and amount" });
    }
    const rep = await SalesRep.findByPk(req.user.repId, { attributes: ["id", "name", "partner_user_id"] }).catch(() => null);
    const out = await payments.create(lead, rep, b, req.app.get("io"));
    return res.json({ status: "1", message: out.sent && !out.sent.success ? `Request saved, but WhatsApp didn't send: ${out.sent.error}` : "Payment request sent", data: out });
  } catch (e) {
    console.error("[payment-request]", e.message);
    return res.status(e.status || 500).json({ status: "0", message: e.message });
  }
});

router.get("/:leadId/payment-requests", auth, async (req, res) => {
  try {
    const lead = await ownedLead(req, res);
    if (!lead) return;
    return res.json({ status: "1", data: await payments.listFor(lead.id) });
  } catch (e) {
    return res.status(500).json({ status: "0", message: e.message });
  }
});

router.post("/:leadId/payment-requests/:id/check", auth, async (req, res) => {
  try {
    const lead = await ownedLead(req, res);
    if (!lead) return;
    const { Message } = require("../../models");
    const msg = await Message.findOne({ where: { id: req.body?.message_id, lead_id: lead.id } });
    if (!msg || !msg.media_url) return res.status(400).json({ status: "0", message: "Pick a photo she sent" });
    const out = await payments.checkSlip(lead, msg.toJSON ? msg.toJSON() : msg, { io: req.app.get("io"), requestId: Number(req.params.id), manual: true });
    if (!out) return res.status(400).json({ status: "0", message: "No open payment request, or the photo couldn't be read" });
    return res.json({ status: "1", data: out });
  } catch (e) {
    return res.status(500).json({ status: "0", message: e.message });
  }
});

router.post("/:leadId/payment-requests/:id/cancel", auth, async (req, res) => {
  try {
    const lead = await ownedLead(req, res);
    if (!lead) return;
    return res.json({ status: "1", data: await payments.cancel(lead, Number(req.params.id)) });
  } catch (e) {
    return res.status(500).json({ status: "0", message: e.message });
  }
});

module.exports = router;
