/**
 * supportTickets.routes.js — app support tickets for every CRM rep (Nov 2026).
 *
 * The tickets live in partner_backend. The CRM calls its signed internal API
 * (partner helper/crmSignature.js) on the rep's behalf, so it works whatever
 * way the rep logged in (CRM password or partner login):
 *   GET  /api/support-tickets?status=open|overdue|resolved
 *   GET  /api/support-tickets/:id
 *   POST /api/support-tickets/:id/reply   { message }
 * Reps see every ticket and can reply (signed as the rep, by name); only
 * Admin resolves, in the admin portal. Signature:
 *   HMAC(APP_WEBHOOK_SECRET, "<ts>.<METHOD>.<path+query>.<JSON body or empty>")
 */
const express = require("express");
const auth = require("../middleware/auth.middleware");
const { SalesRep } = require("../../models");

const router = express.Router();
const { partnerCall } = require("../services/partnerSigned");

const send = (res, p) =>
  p.then((data) => res.json(data)).catch((e) => {
    console.error("[support-tickets]", e.message);
    res.status(e.status || 502).json({ error: e.message });
  });

router.get("/", auth, (req, res) => {
  const status = ["open", "overdue", "resolved", "all"].includes(req.query.status) ? req.query.status : "open";
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  return send(res, partnerCall("GET", `/internal/crm/support-tickets?status=${status}&limit=50&page=${page}`));
});

// Express 5: no inline regex in paths, so check the id here.
const ticketId = (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== req.params.id) {
    res.status(400).json({ error: "bad ticket id" });
    return null;
  }
  return id;
};

router.get("/:id", auth, (req, res) => {
  const id = ticketId(req, res);
  if (id) send(res, partnerCall("GET", `/internal/crm/support-tickets/${id}`));
});

router.post("/:id/reply", auth, async (req, res) => {
  const id = ticketId(req, res);
  if (!id) return;
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "message is required" });
  const rep = await SalesRep.findByPk(req.user.repId, { attributes: ["id", "name"] }).catch(() => null);
  return send(res, partnerCall("POST", `/internal/crm/support-tickets/${id}/reply`, {
    message: message.slice(0, 4000),
    agent_name: (rep && rep.name) || "FitHer Support",
  }));
});

module.exports = router;
