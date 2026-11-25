const express = require("express");
const bcrypt = require("bcrypt");
const auth = require("../middleware/auth.middleware");
const sequelize = require("../config/database");
const { SalesRep, People, Activity, Event, Integration, WhatsAppAccount, Message } = require("../../models");
const {
  createBaileysClient,
  getLatestQr,
  getPairingCode,
  isAccountConnected,
  disconnectBaileysClient,
} = require("../whatsapp/baileysClient");
const ctrl = require("../controllers/admin.controller");
const {
  getSalesRepPerformance,
  getAllSalesRepsPerformance,
} = require("../controllers/salesRepPerformance.controller");

const router = express.Router();

// ── Admin role guard ───────────────────────────────────────────
// Use AFTER `auth` middleware. Returns 403 if the authenticated user is not admin.
function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// ── Auth: create sales rep ─────────────────────────────────────
router.post("/sales-reps", auth, adminOnly, async (req, res) => {
  try {
    const { name, email, password, whatsapp_account_id } = req.body || {};
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }
    const hashed = await bcrypt.hash(password, 10);
    const validRole = req.body.role === "admin" ? "admin" : "rep";
    const rep = await SalesRep.create({ name, email, password: hashed, whatsapp_account_id, role: validRole });
    // Never return the password hash.
    res.json({
      id: rep.id,
      name: rep.name,
      email: rep.email,
      role: rep.role,
      status: rep.status,
      whatsapp_account_id: rep.whatsapp_account_id,
      partner_user_id: rep.partner_user_id ?? null,
      createdAt: rep.createdAt,
      updatedAt: rep.updatedAt,
    });
  } catch (err) {
    if (err.name === "SequelizeUniqueConstraintError") {
      return res.status(400).json({ error: "A sales rep with this email already exists" });
    }
    if (err.name === "SequelizeValidationError") {
      return res.status(400).json({ error: "name, email and whatsapp_account_id are required" });
    }
    console.error("❌ create sales-rep:", err);
    res.status(500).json({ error: "Failed to create sales rep" });
  }
});

// ── Update a sales rep / manager ──────────────────────────────
router.put("/sales-reps/:id", auth, adminOnly, async (req, res) => {
  try {
    const rep = await SalesRep.findByPk(req.params.id);
    if (!rep) return res.status(404).json({ error: "Rep not found" });

    const updates = {};
    if (req.body.name) updates.name = req.body.name;
    if (req.body.email) updates.email = req.body.email;
    if (req.body.role === "admin" || req.body.role === "rep") updates.role = req.body.role;
    if (req.body.status === "active" || req.body.status === "inactive") updates.status = req.body.status;
    if (req.body.whatsapp_account_id) updates.whatsapp_account_id = req.body.whatsapp_account_id;
    // Per-rep Fiza autonomy. Accept an explicit mode, or null to clear it
    // (back to the channel default). Guardrails in replyOwner still apply.
    if (["copilot", "autopilot"].includes(req.body.fiza_mode)) updates.fiza_mode = req.body.fiza_mode;
    else if (req.body.fiza_mode === null) updates.fiza_mode = null;
    if (typeof req.body.password === "string" && req.body.password.length >= 8) {
      updates.password = await bcrypt.hash(req.body.password, 10);
    }

    await rep.update(updates);
    res.json({
      id: rep.id, name: rep.name, email: rep.email, role: rep.role,
      status: rep.status, whatsapp_account_id: rep.whatsapp_account_id,
      fiza_mode: rep.fiza_mode ?? null,
    });
  } catch (err) {
    if (err.name === "SequelizeUniqueConstraintError") {
      return res.status(400).json({ error: "Email already in use" });
    }
    console.error("update sales-rep:", err);
    res.status(500).json({ error: "Failed to update" });
  }
});

// ── Delete a sales rep (soft: set inactive) ───────────────────
router.delete("/sales-reps/:id", auth, adminOnly, async (req, res) => {
  try {
    const rep = await SalesRep.findByPk(req.params.id);
    if (!rep) return res.status(404).json({ error: "Rep not found" });
    // Don't let admin delete themselves
    if (rep.id === req.user.repId) {
      return res.status(400).json({ error: "Cannot deactivate yourself" });
    }
    await rep.update({ status: "inactive" });
    res.json({ success: true });
  } catch (err) {
    console.error("delete sales-rep:", err);
    res.status(500).json({ error: "Failed to deactivate" });
  }
});

// ── Resolve an app support issue + notify the user ─────────────
// POST /api/admin/leads/:id/resolve-issue   body: { message }
// Stores the admin's custom reply on the conversation, clears the escalation
// flag, and asks partner_backend to push the note to the user's device.
router.post("/leads/:id/resolve-issue", auth, adminOnly, async (req, res) => {
  try {
    const note = (req.body?.message || "").toString().trim();
    if (!note) return res.status(400).json({ error: "message is required" });

    const person = await People.findByPk(req.params.id);
    if (!person) return res.status(404).json({ error: "Lead not found" });

    // 1. Record the admin's reply on the conversation (outbound app message).
    await require("../services/frontDesk").saveMessage({
      contact: person, direction: "OUT", channel: "app", from: "rep", text: note,
      accountId: person.whatsapp_account_id || 1, repId: req.user.repId || null,
    });

    // 2. Clear the escalation + bump activity; mark the open issue resolved.
    await person.update({ is_escalated: false, last_message_at: new Date() });
    await sequelize.query(
      `UPDATE app_issues
          SET status = 'resolved', resolved_note = :note, resolved_by = :rep, resolved_at = NOW()
        WHERE lead_id = :lead AND status = 'open'`,
      { replacements: { note, rep: req.user.repId || null, lead: person.id } }
    ).catch((e) => console.error("[resolve-issue] app_issues update failed:", e.message));

    // 3. Push the note to the user's device via partner_backend (which holds
    //    the FCM token). Non-fatal if it fails — the reply is already saved.
    const { pushToApp } = require("../services/appPush");
    const push = await pushToApp({
      appUserId: person.app_user_id,
      title: "Your issue has been resolved",
      body: note,
      data: { lead_id: String(person.id) },
    });
    const notified = push.pushed;
    if (!notified) console.warn("[resolve-issue] push not sent:", push.reason);

    res.json({ success: true, notified });
  } catch (err) {
    console.error("❌ resolve-issue:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── App Issues list (dedicated "Client App Issues" section) ────
// GET /api/admin/app-issues?status=open|resolved|all
router.get("/app-issues", auth, adminOnly, async (req, res) => {
  try {
    const status = ["open", "resolved"].includes(req.query.status) ? req.query.status : null;
    const [rows] = await sequelize.query(
      `SELECT ai.id, ai.lead_id, ai.category, ai.priority, ai.message, ai.image_url,
              ai.plan_title, ai.status, ai.resolved_note, ai.resolved_at, ai.created_at,
              l.name AS lead_name, l.phone AS lead_phone, l.app_user_id
         FROM app_issues ai
         JOIN leads l ON l.id = ai.lead_id
        ${status ? "WHERE ai.status = :status" : ""}
        ORDER BY (ai.status = 'open') DESC, ai.created_at DESC
        LIMIT 200`,
      { replacements: status ? { status } : {} }
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ app-issues list:", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// WhatsApp accounts — connect / list / QR / disconnect a number
// Lets an admin link additional WhatsApp numbers from the dashboard
// without server access or a restart. Each account runs its own
// Baileys socket (see baileysClient.js).
// ════════════════════════════════════════════════════════════════

// List all accounts with live connection state.
router.get("/whatsapp-accounts", auth, adminOnly, async (req, res) => {
  try {
    const accounts = await WhatsAppAccount.findAll({ order: [["id", "ASC"]] });
    res.json(
      accounts.map((a) => ({
        id: a.id,
        phone_number: a.phone_number,
        status: a.status,
        connected: isAccountConnected(a.id),
        awaiting_qr: !!getLatestQr(a.id),
      }))
    );
  } catch (err) {
    console.error("❌ list whatsapp-accounts:", err);
    res.status(500).json({ error: err.message });
  }
});

// Create a new account row and start its Baileys socket on demand.
// The phone number is a placeholder until the QR is scanned, then
// backfilled automatically when the connection opens.
router.post("/whatsapp-accounts", auth, adminOnly, async (req, res) => {
  try {
    const io = req.app.get("io");

    // "Link with phone number" (code) mode when a phone is supplied.
    const rawPhone = String(req.body?.phone || "").replace(/\D/g, "");
    const useCode = req.body?.method === "code" && rawPhone.length >= 8;
    if (req.body?.method === "code" && !useCode) {
      return res.status(400).json({ error: "A valid phone number (with country code) is required for code linking" });
    }

    const account = await WhatsAppAccount.create({
      phone_number: useCode ? rawPhone : `pending-${Date.now()}`,
      session_path: "pending",
      status: "active",
    });
    await account.update({ session_path: `baileys_sessions/${account.id}` });

    // Spin up the socket now. In code mode the 8-char pairing code is pushed via
    // socket 'wa-pairing-code' and is fetchable at /whatsapp-accounts/:id/qr;
    // otherwise the QR is pushed via 'wa-qr'.
    await createBaileysClient(account.id, io, useCode ? { phoneNumber: rawPhone } : {});

    res.status(201).json({
      id: account.id,
      status: "starting",
      method: useCode ? "code" : "qr",
      message: useCode
        ? "A pairing code is being generated — enter it in WhatsApp → Linked devices → Link with phone number."
        : "Open the QR for this account and scan it with WhatsApp → Linked devices.",
    });
  } catch (err) {
    console.error("❌ create whatsapp-account:", err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch the current QR for linking. Returns a scannable image data URL when
// the optional `qrcode` package is installed, otherwise the raw QR string.
router.get("/whatsapp-accounts/:id/qr", auth, adminOnly, async (req, res) => {
  try {
    const accountId = Number(req.params.id);
    if (isAccountConnected(accountId)) {
      return res.json({ connected: true, qr_image: null, qr_string: null, pairing_code: null });
    }

    // Code-linking mode: return the pairing code if it's ready.
    const pairing = getPairingCode(accountId);
    if (pairing) {
      return res.json({ connected: false, pairing_code: pairing, qr_image: null, qr_string: null });
    }

    const raw = getLatestQr(accountId);
    if (!raw) {
      return res.json({
        connected: false,
        qr_image: null,
        qr_string: null,
        pairing_code: null,
        message: "Not ready yet — retry in a second.",
      });
    }
    let qrImage = null;
    try {
      const QRCode = require("qrcode"); // optional dep — lazy so server boots without it
      qrImage = await QRCode.toDataURL(raw);
    } catch (_) {
      /* package not installed → fall back to the raw string for the client to render */
    }
    res.json({ connected: false, qr_image: qrImage, qr_string: raw, pairing_code: null });
  } catch (err) {
    console.error("❌ whatsapp-account qr:", err);
    res.status(500).json({ error: err.message });
  }
});

// Reconnect/start an existing account (e.g. after a manual disconnect).
router.post("/whatsapp-accounts/:id/connect", auth, adminOnly, async (req, res) => {
  try {
    const io = req.app.get("io");
    const accountId = Number(req.params.id);
    await WhatsAppAccount.update({ status: "active" }, { where: { id: accountId } });
    await createBaileysClient(accountId, io);
    res.json({ success: true, message: "Connecting — fetch the QR if a scan is required." });
  } catch (err) {
    console.error("❌ connect whatsapp-account:", err);
    res.status(500).json({ error: err.message });
  }
});

// Disconnect an account's socket (session preserved; no auto-reconnect).
router.post("/whatsapp-accounts/:id/disconnect", auth, adminOnly, async (req, res) => {
  try {
    const accountId = Number(req.params.id);
    await disconnectBaileysClient(accountId);
    await WhatsAppAccount.update({ status: "inactive" }, { where: { id: accountId } });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ disconnect whatsapp-account:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── List all sales reps with details ──────────────────────────
router.get("/managers", auth, adminOnly, async (req, res) => {
  try {
    const reps = await SalesRep.findAll({
      attributes: ["id", "name", "email", "role", "status", "whatsapp_account_id", "createdAt"],
      include: [{ model: WhatsAppAccount, attributes: ["id", "phone_number", "label"] }],
      order: [["role", "DESC"], ["name", "ASC"]],
    });
    res.json(reps);
  } catch (err) {
    console.error("list managers:", err);
    res.status(500).json({ error: "Failed to list" });
  }
});

// ── Dashboard ──────────────────────────────────────────────────
router.get("/dashboard", auth, adminOnly, ctrl.dashboard);

// ── People (was leads) ─────────────────────────────────────────
// Both /people and /leads routes work — /leads kept for frontend compat
router.get("/people", auth, adminOnly, ctrl.getLeads);
router.get("/people/:id", auth, adminOnly, ctrl.getLeadDetails);
router.get("/leads", auth, adminOnly, ctrl.getLeads);
router.get("/leads/:id", auth, adminOnly, ctrl.getLeadDetails);

// ── Conversations / Media / Team / Analytics ───────────────────
router.get("/conversations", auth, adminOnly, ctrl.getConversations);
router.get("/media", auth, adminOnly, ctrl.getMediaLogs);
router.get("/sales-team", auth, adminOnly, ctrl.getSalesTeam);
router.get("/analytics", auth, adminOnly, ctrl.getAnalytics);

// ── Performance ────────────────────────────────────────────────
// Previously these had NO auth — now require admin login
router.get("/sales-reps/:salesRepId/performance", auth, adminOnly, getSalesRepPerformance);
router.get("/sales-reps/performance", auth, adminOnly, getAllSalesRepsPerformance);

// ── CRM: Activity timeline for a person ───────────────────────
router.get("/people/:id/timeline", auth, adminOnly, async (req, res) => {
  try {
    const activities = await Activity.findAll({
      where: { lead_id: req.params.id },
      order: [["created_at", "DESC"]],
      limit: 200,
    });
    res.json(activities);
  } catch (err) {
    console.error("Timeline error:", err);
    res.status(500).json({ error: "Failed to fetch timeline" });
  }
});

// ── CRM: Events for a person ───────────────────────────────────
router.get("/people/:id/events", auth, adminOnly, async (req, res) => {
  try {
    const events = await Event.findAll({
      where: { lead_id: req.params.id },
      order: [["created_at", "DESC"]],
      limit: 100,
    });
    res.json(events);
  } catch (err) {
    console.error("Events error:", err);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// ── CRM: Update person stage ───────────────────────────────────
router.patch("/people/:id/stage", auth, adminOnly, async (req, res) => {
  try {
    const { stage } = req.body;
    const allowed = ["visitor", "lead", "user", "churned"];
    if (!allowed.includes(stage)) return res.status(400).json({ error: "Invalid stage" });

    const person = await People.findByPk(req.params.id);
    if (!person) return res.status(404).json({ error: "Person not found" });

    person.stage = stage;
    if (stage === "churned" && req.body.churn_trigger) {
      person.churn_trigger = req.body.churn_trigger;
    }
    await person.save();

    // Fire event for automation engine
    const { fireEvent } = require("../services/event.service");
    if (stage === "churned") {
      await fireEvent(person.id, "churn_detected", { trigger: person.churn_trigger });
    }

    res.json({ success: true, stage, id: person.id });
  } catch (err) {
    console.error("Stage update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── CRM: Integrations health ───────────────────────────────────
router.get("/integrations", auth, adminOnly, async (req, res) => {
  try {
    const integrations = await Integration.findAll();
    res.json(integrations);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch integrations" });
  }
});

module.exports = router;
