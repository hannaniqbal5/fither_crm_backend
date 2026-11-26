/**
 * identity.routes.js — one woman = one lead (Nov 2026).
 *
 * The rule ("the door she comes through decides who she is"):
 *   - App-first: her app account (app_user_id) is her identity from signup.
 *   - WhatsApp-first: her WhatsApp number is her identity until she signs up;
 *     the rep's signup / trial / pay link carries her lead id, so the app
 *     account is linked to exactly that lead.
 *   - Anything else (same typed phone or email, no link) is only a
 *     SUGGESTION a rep confirms ("Same person" / "Not her") — never an
 *     automatic merge. Every merge is recorded on the lead's timeline.
 *
 * Admin:
 *   GET  /api/identity/report                 duplicates + missing leads + phone formats
 *   POST /api/identity/fix-phone-formats      { apply: true } — normalize old phones where safe
 * Reps (own lead, or admin):
 *   GET  /api/identity/suggestions?leadId=    open possible matches for a lead
 *   POST /api/identity/suggestions/:id/confirm  → merge the app account into the WhatsApp lead
 *   POST /api/identity/suggestions/:id/reject
 */
const express = require("express");
const auth = require("../middleware/auth.middleware");
const adminOnly = require("../middleware/adminOnly");
const sequelize = require("../config/database");
const { normalizePhoneDigits } = require("../services/phoneCountry");
const { partnerCall } = require("../services/partnerSigned");

const router = express.Router();
const isAdmin = (req) => req.user?.role === "admin";

// Only a real phone number is normalized / compared. Junk like
// "92300TEST001" (letters) or too-short numbers stays as it is, so it is
// never "fixed" into a different number or grouped with other leads.
function cleanPhone(raw) {
  if (!raw) return null;
  if (/[a-z]/i.test(String(raw))) return null;
  const n = normalizePhoneDigits(raw);
  return n && /^\d{11,15}$/.test(n) ? n : null;
}

// ── Report ────────────────────────────────────────────────────
router.get("/report", auth, adminOnly, async (req, res) => {
  try {
    const [leads] = await sequelize.query(
      `SELECT id, name, phone, email, app_user_id, source, whatsapp_account_id, assigned_to,
              subscription_status, created_at
         FROM leads WHERE merged_into_lead_id IS NULL`
    );
    const sample = (arr, n = 25) => arr.slice(0, n);

    // 1. Same app account on more than one lead (blocks the unique index).
    const byApp = {};
    for (const l of leads) if (l.app_user_id) (byApp[l.app_user_id] = byApp[l.app_user_id] || []).push(l);
    const dupAppUser = Object.entries(byApp).filter(([, a]) => a.length > 1)
      .map(([app_user_id, a]) => ({ app_user_id, leads: a.map((l) => ({ id: l.id, name: l.name, phone: l.phone, source: l.source })) }));

    // 2. Same (normalized) phone on more than one lead.
    const byPhone = {};
    const badFormat = [];
    for (const l of leads) {
      if (!l.phone) continue;
      const n = cleanPhone(l.phone);
      if (n && n !== l.phone) badFormat.push({ id: l.id, phone: l.phone, normalized: n });
      const key = n || `raw:${l.phone}`;
      (byPhone[key] = byPhone[key] || []).push(l);
    }
    const dupPhone = Object.entries(byPhone).filter(([, a]) => a.length > 1)
      .map(([phone, a]) => ({ phone, leads: a.map((l) => ({ id: l.id, name: l.name, app_user_id: l.app_user_id, source: l.source, wa_account: l.whatsapp_account_id, subscription: l.subscription_status })) }));

    // 3. App accounts vs leads (needs partner_backend).
    let partner = null;
    try {
      const data = await partnerCall("GET", "/internal/crm/customers");
      const customers = data.customers || [];
      const appIds = new Set(customers.map((c) => String(c.id)));
      const missing = customers.filter((c) => !byApp[String(c.id)]);
      const unknown = leads.filter((l) => l.app_user_id && !appIds.has(String(l.app_user_id)));
      partner = {
        app_customers: customers.length,
        app_customers_without_lead: missing.length,
        app_customers_without_lead_sample: sample(missing.map((c) => ({ id: c.id, name: `${c.firstName || ""} ${c.lastName || ""}`.trim(), phone: c.phone, signed_up: c.createdAt }))),
        leads_with_unknown_app_user: unknown.length,
        leads_with_unknown_app_user_sample: sample(unknown.map((l) => ({ id: l.id, name: l.name, app_user_id: l.app_user_id }))),
      };
    } catch (e) {
      partner = { error: `Could not reach the app backend: ${e.message}` };
    }

    let openSuggestions = null;
    try {
      const [[r]] = await sequelize.query("SELECT COUNT(*) AS n FROM lead_match_suggestions WHERE status = 'open'");
      openSuggestions = Number(r.n);
    } catch (_) { openSuggestions = "table not created yet (run migration 036)"; }

    res.json({
      active_leads: leads.length,
      duplicate_app_accounts: { count: dupAppUser.length, items: sample(dupAppUser) },
      duplicate_phones: { count: dupPhone.length, items: sample(dupPhone) },
      phones_in_old_format: { count: badFormat.length, items: sample(badFormat) },
      app_vs_crm: partner,
      open_match_suggestions: openSuggestions,
    });
  } catch (err) {
    console.error("[identity report]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Is she already in the app? ─────────────────────────────────
//   GET /api/identity/app-account?phone=0326...&email=a@b.com
// Asks the app backend for customers matching the phone (last 10 digits)
// OR the email. Used before taking a payment, so a paid plan lands on the
// right account. Any signed-in rep may ask (reps take payments too).
router.get("/app-account", auth, async (req, res) => {
  try {
    const phone = String(req.query.phone || "").replace(/\D/g, "");
    const email = String(req.query.email || "").trim().toLowerCase();
    if (phone.length < 10 && !email.includes("@")) {
      return res.status(400).json({ error: "Give a phone (10+ digits) or an email" });
    }
    const qs = new URLSearchParams();
    if (phone.length >= 10) qs.set("phone", phone);
    if (email.includes("@")) qs.set("email", email);
    const data = await partnerCall("GET", `/internal/crm/customers?${qs}`);
    const customers = (data.customers || []).map((c) => ({
      app_user_id: c.id,
      name: `${c.firstName || ""} ${c.lastName || ""}`.trim() || null,
      phone: c.phone || null,
      email: c.email || null,
      signed_up: c.createdAt || null,
      matched_by: [
        phone.length >= 10 && String(c.phone || "").replace(/\D/g, "").endsWith(phone.slice(-10)) ? "phone" : null,
        email && String(c.email || "").toLowerCase() === email ? "email" : null,
      ].filter(Boolean),
    })).filter((c) => c.matched_by.length); // an older app backend ignores the filter
    res.json({ found: customers.length, customers });
  } catch (err) {
    res.status(502).json({ error: `Could not reach the app backend: ${err.message}` });
  }
});

// ── Normalize old phone formats (safe: skips any that would collide) ──
router.post("/fix-phone-formats", auth, adminOnly, async (req, res) => {
  try {
    const apply = req.body?.apply === true;
    const [leads] = await sequelize.query(
      "SELECT id, phone, whatsapp_account_id FROM leads WHERE phone IS NOT NULL AND merged_into_lead_id IS NULL"
    );
    const taken = new Set(leads.map((l) => `${l.phone}|${l.whatsapp_account_id}`));
    const fixed = [], skipped = [];
    for (const l of leads) {
      const n = cleanPhone(l.phone);
      if (!n || n === l.phone) continue;
      const key = `${n}|${l.whatsapp_account_id}`;
      if (taken.has(key)) { skipped.push({ id: l.id, phone: l.phone, normalized: n, reason: "another lead already has this number — duplicate, see report" }); continue; }
      if (apply) {
        await sequelize.query("UPDATE leads SET phone = :n WHERE id = :id", { replacements: { n, id: l.id } });
        taken.delete(`${l.phone}|${l.whatsapp_account_id}`);
      }
      taken.add(key);
      fixed.push({ id: l.id, from: l.phone, to: n });
    }
    res.json({ applied: apply, fixed: fixed.length, skipped: skipped.length, fixed_items: fixed.slice(0, 50), skipped_items: skipped.slice(0, 50) });
  } catch (err) {
    console.error("[identity fix-phone-formats]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Possible-match suggestions ────────────────────────────────
async function loadSuggestion(id) {
  const [rows] = await sequelize.query("SELECT * FROM lead_match_suggestions WHERE id = :id", { replacements: { id } });
  return rows[0] || null;
}
async function repMayAct(req, s) {
  if (isAdmin(req)) return true;
  const [rows] = await sequelize.query(
    "SELECT id FROM leads WHERE id IN (:a, :b) AND assigned_to = :rep",
    { replacements: { a: s.lead_id, b: s.candidate_lead_id, rep: req.user.repId } }
  );
  return rows.length > 0;
}

router.get("/suggestions", auth, async (req, res) => {
  try {
    const leadId = parseInt(req.query.leadId, 10);
    if (!leadId) return res.status(400).json({ error: "leadId is required" });
    const [rows] = await sequelize.query(
      `SELECT s.id, s.lead_id, s.candidate_lead_id, s.reason, s.detail, s.created_at,
              IF(s.lead_id = :id, c.name, l.name)                  AS other_name,
              IF(s.lead_id = :id, c.phone, l.phone)                AS other_phone,
              IF(s.lead_id = :id, c.source, l.source)              AS other_source,
              IF(s.lead_id = :id, s.candidate_lead_id, s.lead_id)  AS other_lead_id
         FROM lead_match_suggestions s
         JOIN leads l ON l.id = s.lead_id
         JOIN leads c ON c.id = s.candidate_lead_id
        WHERE s.status = 'open' AND (s.lead_id = :id OR s.candidate_lead_id = :id)
        ORDER BY s.id DESC`,
      { replacements: { id: leadId } }
    );
    res.json(rows);
  } catch (err) {
    if (/lead_match_suggestions/.test(err.message)) return res.json([]); // migration not run yet
    res.status(500).json({ error: err.message });
  }
});

router.post("/suggestions/:id/confirm", auth, async (req, res) => {
  try {
    const s = await loadSuggestion(parseInt(req.params.id, 10));
    if (!s || s.status !== "open") return res.status(404).json({ error: "Suggestion not found or already handled" });
    if (!(await repMayAct(req, s))) return res.status(403).json({ error: "Not your lead" });
    // lead_id = the app lead (has the app account); candidate = the existing
    // WhatsApp lead she really is. Attach the app account to the WhatsApp
    // lead; the app lead is merged into it (kept for history).
    const [[appLead]] = await sequelize.query("SELECT id, app_user_id FROM leads WHERE id = :id", { replacements: { id: s.lead_id } });
    if (!appLead?.app_user_id) return res.status(409).json({ error: "The app lead has no app account any more" });
    const { linkByCrmLeadId } = require("../app_integration/handlers");
    const linked = await linkByCrmLeadId(s.candidate_lead_id, String(appLead.app_user_id));
    if (!linked) return res.status(409).json({ error: "That lead is already linked to a different app account — ask an admin" });
    await sequelize.query(
      "UPDATE lead_match_suggestions SET status = 'confirmed', decided_by = :rep, decided_at = NOW() WHERE id = :id",
      { replacements: { rep: req.user.repId || null, id: s.id } }
    );
    const { writeActivity } = require("../services/activity.service");
    await writeActivity(s.candidate_lead_id, "identity_confirmed", "crm", { suggestion_id: s.id, app_lead: s.lead_id, by: req.user.repId, reason: s.reason });
    res.json({ success: true, lead_id: s.candidate_lead_id });
  } catch (err) {
    console.error("[identity confirm]", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/suggestions/:id/reject", auth, async (req, res) => {
  try {
    const s = await loadSuggestion(parseInt(req.params.id, 10));
    if (!s || s.status !== "open") return res.status(404).json({ error: "Suggestion not found or already handled" });
    if (!(await repMayAct(req, s))) return res.status(403).json({ error: "Not your lead" });
    await sequelize.query(
      "UPDATE lead_match_suggestions SET status = 'rejected', decided_by = :rep, decided_at = NOW() WHERE id = :id",
      { replacements: { rep: req.user.repId || null, id: s.id } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── App signup link for a WhatsApp lead (the WhatsApp-first door) ──
// POST /api/identity/signup-link/:leadId → { url, expires_at }
// The link carries a signed ref (services/signupRef.js); when she signs up
// from it, user_signup brings the ref back and she lands on THIS lead,
// whatever phone she types.
router.post("/signup-link/:leadId", auth, async (req, res) => {
  try {
    const leadId = parseInt(req.params.leadId, 10);
    const [[lead]] = await sequelize.query(
      "SELECT id, assigned_to, app_user_id FROM leads WHERE id = :id AND merged_into_lead_id IS NULL",
      { replacements: { id: leadId } }
    );
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!isAdmin(req) && lead.assigned_to && Number(lead.assigned_to) !== Number(req.user.repId)) {
      return res.status(403).json({ error: "Not your lead" });
    }
    if (lead.app_user_id) return res.status(409).json({ error: "She already has an app account" });
    const days = 30;
    const ref = require("../services/signupRef").make(lead.id, days);
    const base = (process.env.APP_WEB_URL || "http://localhost:3000").replace(/\/$/, "");
    const { writeActivity } = require("../services/activity.service");
    await writeActivity(lead.id, "signup_link_created", "crm", { by: req.user.repId || null });
    res.json({ url: `${base}/signup?ref=${encodeURIComponent(ref)}`, expires_at: new Date(Date.now() + days * 86400000).toISOString() });
  } catch (err) {
    console.error("[identity signup-link]", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
