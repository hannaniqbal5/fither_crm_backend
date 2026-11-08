/**
 * paymentAccounts.routes.js — admin CRUD + rep-facing lookup for payment accounts.
 *
 * Admin endpoints (require role=admin):
 *   GET    /api/admin/payment-accounts            — list all
 *   POST   /api/admin/payment-accounts            — create
 *   PUT    /api/admin/payment-accounts/:id        — update
 *   DELETE /api/admin/payment-accounts/:id        — delete (or just set is_active=false)
 *
 * Rep-facing (any authenticated rep):
 *   GET /api/leads/:leadId/payment-accounts
 *     Returns accounts filtered by lead's detected country + all accounts override
 */

const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");
const { PaymentAccount, People } = require("../../models");
const { detectCountry, getCountryName, getCountryCurrency } = require("../services/phoneCountry");
const { assertOwnsOr403 } = require("../middleware/leadOwnership");

const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
};

// ─── Admin: list all payment accounts ──────────────────────────
router.get("/admin/payment-accounts", auth, adminOnly, async (req, res) => {
  try {
    const accounts = await PaymentAccount.findAll({
      order: [["country_code", "ASC"], ["display_order", "ASC"], ["id", "ASC"]],
    });
    res.json(accounts);
  } catch (err) {
    console.error("list payment accounts error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: create ─────────────────────────────────────────────
router.post("/admin/payment-accounts", auth, adminOnly, async (req, res) => {
  try {
    const {
      country_code, country_name, currency,
      account_type, bank_name, account_holder, account_number,
      iban, branch_code, swift_code, instructions,
      is_active, display_order,
    } = req.body;

    if (!country_code || !country_name || !bank_name || !account_holder || !account_number) {
      return res.status(400).json({ error: "country_code, country_name, bank_name, account_holder, account_number are required" });
    }

    const created = await PaymentAccount.create({
      country_code:   country_code.toUpperCase(),
      country_name,
      currency:       currency || getCountryCurrency(country_code.toUpperCase()) || "PKR",
      account_type:   account_type || "bank",
      bank_name,
      account_holder,
      account_number,
      iban:           iban           || null,
      branch_code:    branch_code    || null,
      swift_code:     swift_code     || null,
      instructions:   instructions   || null,
      is_active:      is_active !== false,
      display_order:  display_order  || 0,
      created_by:     req.user?.repId || null,
    });

    res.json(created);
  } catch (err) {
    console.error("create payment account error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: update ─────────────────────────────────────────────
router.put("/admin/payment-accounts/:id", auth, adminOnly, async (req, res) => {
  try {
    const acc = await PaymentAccount.findByPk(req.params.id);
    if (!acc) return res.status(404).json({ error: "Not found" });

    const updatable = [
      "country_code", "country_name", "currency",
      "account_type", "bank_name", "account_holder", "account_number",
      "iban", "branch_code", "swift_code", "instructions",
      "is_active", "display_order",
    ];
    for (const key of updatable) {
      if (req.body[key] !== undefined) acc[key] = req.body[key];
    }
    if (req.body.country_code) acc.country_code = req.body.country_code.toUpperCase();

    await acc.save();
    res.json(acc);
  } catch (err) {
    console.error("update payment account error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: delete ─────────────────────────────────────────────
router.delete("/admin/payment-accounts/:id", auth, adminOnly, async (req, res) => {
  try {
    const acc = await PaymentAccount.findByPk(req.params.id);
    if (!acc) return res.status(404).json({ error: "Not found" });
    await acc.destroy();
    res.json({ ok: true });
  } catch (err) {
    console.error("delete payment account error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Rep-facing: country-filtered list for a lead ──────────────
router.get("/leads/:leadId/payment-accounts", auth, async (req, res) => {
  try {
    const lead = await People.findByPk(req.params.leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!assertOwnsOr403(req, res, lead)) return;

    const phone = lead.phone || lead.whatsapp_jid?.split("@")[0] || null;
    const detectedCountry = detectCountry(phone);
    const detectedCountryName = getCountryName(detectedCountry);

    const recommended = detectedCountry
      ? await PaymentAccount.findAll({
          where: { country_code: detectedCountry, is_active: true },
          order: [["display_order", "ASC"], ["id", "ASC"]],
        })
      : [];

    const all = await PaymentAccount.findAll({
      where: { is_active: true },
      order: [["country_code", "ASC"], ["display_order", "ASC"], ["id", "ASC"]],
    });

    // Group "all" by country for the override view
    const allByCountry = {};
    for (const a of all) {
      if (!allByCountry[a.country_name]) {
        allByCountry[a.country_name] = { country: a.country_name, country_code: a.country_code, currency: a.currency, accounts: [] };
      }
      allByCountry[a.country_name].accounts.push(a);
    }

    res.json({
      detectedCountry,
      detectedCountryName,
      recommendedAccounts: recommended,
      allCountriesAccounts: Object.values(allByCountry),
    });
  } catch (err) {
    console.error("lead payment-accounts error:", err);
    res.status(500).json({ error: "Failed to load payment accounts" });
  }
});

module.exports = router;
