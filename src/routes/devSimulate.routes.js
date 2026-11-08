/**
 * devSimulate.routes.js — Phase 16. QA endpoint for testing Fiza without real WhatsApp.
 *
 * Routes:
 *   POST   /api/dev/simulate-inbound   — push a fake customer message
 *   GET    /api/dev/test-leads         — list test leads (phones starting with TEST_PHONE_PREFIX)
 *   POST   /api/dev/reset-lead/:id     — wipe a test lead's data and start fresh
 *   POST   /api/dev/mark-approved      — simulate rep approving Fiza's latest draft
 *
 * Guard: requires ENABLE_DEV_SIMULATE=true in env (otherwise 403) AND an
 * authenticated admin.
 *
 * Test phones use the convention: TEST_PHONE_PREFIX (default "92300TEST") so
 * we can easily wipe all test data without touching real leads.
 */

const express = require("express");
const router  = express.Router();
const sequelize = require("../config/database");
const { handleIncomingWhatsAppMessage } = require("../whatsapp/message.handler");
const auth = require("../middleware/auth.middleware");
const adminOnly      = require("../middleware/adminOnly");

const TEST_PHONE_PREFIX = process.env.TEST_PHONE_PREFIX || "92300TEST";

// ── Guard ─────────────────────────────────────────────────────
function devGuard(req, res, next) {
  if (process.env.ENABLE_DEV_SIMULATE !== "true") {
    return res.status(403).json({ error: "Dev simulate is disabled. Set ENABLE_DEV_SIMULATE=true to enable." });
  }
  next();
}
router.use(devGuard, auth, adminOnly);

// ── Helper: wait for Fiza's draft to land ─────────────────────
async function waitForDraft(leadId, sinceTs, maxMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const [rows] = await sequelize.query(
      `SELECT reply_id, user_message, ai_response, confidence,
              escalate_reason, status, retrieved_chunks, created_at
         FROM ai_replies
         WHERE lead_id = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      { replacements: [leadId, sinceTs] }
    );
    if (rows[0]) return rows[0];
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function loadLead(leadId) {
  const [rows] = await sequelize.query(
    `SELECT id, name, phone, stage, status, lead_score,
            interaction_status, main_goal, last_objection, funnel_stage,
            engagement_step, auto_followup_paused, last_message_at,
            assigned_to, source, whatsapp_jid, whatsapp_account_id
       FROM leads WHERE id = ?`,
    { replacements: [leadId] }
  );
  return rows[0] || null;
}

async function loadRecentMessages(leadId, limit = 20) {
  const [rows] = await sequelize.query(
    `SELECT id, lead_id, direction, message, message_type, status, created_at, \`from\`
       FROM messages WHERE lead_id = ? ORDER BY created_at ASC LIMIT ?`,
    { replacements: [leadId, limit] }
  );
  return rows;
}

// ──────────────────────────────────────────────────────────────
// POST /api/dev/simulate-inbound
// body: { phone, text, fresh_lead?: boolean }
// Returns: { lead, fiza_draft, recent_messages, latency_ms }
// ──────────────────────────────────────────────────────────────
router.post("/simulate-inbound", async (req, res) => {
  try {
    const { phone, text, fresh_lead = false } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: "text is required" });

    const phoneFinal = phone || `${TEST_PHONE_PREFIX}001`;
    // Safety: only test-prefix phones (mirrors the reset-lead guard) so this
    // endpoint can never inject messages into / wipe a real customer's lead.
    if (!String(phoneFinal).startsWith(TEST_PHONE_PREFIX)) {
      return res.status(400).json({ error: `phone must start with ${TEST_PHONE_PREFIX}` });
    }

    // Optionally wipe this test lead first
    if (fresh_lead) {
      const [rows] = await sequelize.query(
        "SELECT id FROM leads WHERE phone = ?", { replacements: [phoneFinal] }
      );
      if (rows[0]) {
        await sequelize.query("DELETE FROM messages WHERE lead_id = ?", { replacements: [rows[0].id] });
        await sequelize.query("DELETE FROM ai_replies WHERE lead_id = ?", { replacements: [rows[0].id] });
        await sequelize.query("DELETE FROM ai_corrections WHERE reply_id IN (SELECT reply_id FROM ai_replies WHERE lead_id = ?)", { replacements: [rows[0].id] }).catch(() => {});
        await sequelize.query("DELETE FROM leads WHERE id = ?", { replacements: [rows[0].id] });
      }
    }

    const t0 = Date.now();
    const sinceTs = new Date();
    const fakeMsgId = `TEST_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const jid = `${phoneFinal}@s.whatsapp.net`;

    // Need an io object — use a no-op shim if none is mounted
    const io = req.app.get("io") || {
      to: () => ({ emit: () => {} }),
      emit: () => {},
    };

    // Pick the first active WA account so the lead has a valid whatsapp_account_id
    const [accountRows] = await sequelize.query(
      `SELECT id FROM whatsapp_accounts WHERE status = 'active' ORDER BY id ASC LIMIT 1`
    );
    const whatsappAccountId = accountRows[0]?.id || 1;

    // Fire the message handler — same code path real Baileys events go through.
    // It will: save message → write activity → fire intent → trigger Fiza draft (fire-and-forget).
    await handleIncomingWhatsAppMessage({
      whatsapp_jid: jid,
      phone: phoneFinal,
      text,
      whatsappMessageId: fakeMsgId,
      whatsappAccountId,
      io,
      fromMe: false,
      message_type: "text",
    });

    // Lookup the lead by jid (may have been just created)
    const [leadRows] = await sequelize.query(
      "SELECT id FROM leads WHERE whatsapp_jid = ?", { replacements: [jid] }
    );
    if (!leadRows[0]) return res.status(500).json({ error: "Lead not created" });
    const leadId = leadRows[0].id;

    // Wait up to 15s for Fiza's draft (batcher waits 8s + Gemini call ~2-5s)
    const draft = await waitForDraft(leadId, sinceTs);
    const lead = await loadLead(leadId);
    const recentMessages = await loadRecentMessages(leadId, 30);

    res.json({
      lead,
      fiza_draft: draft,
      recent_messages: recentMessages,
      latency_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error("[dev/simulate-inbound]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/dev/test-leads — list all test leads
// ──────────────────────────────────────────────────────────────
router.get("/test-leads", async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT id, phone, name, stage, lead_score, interaction_status, main_goal,
              funnel_stage, engagement_step, last_message_at, created_at
         FROM leads WHERE phone LIKE ?
         ORDER BY last_message_at DESC LIMIT 50`,
      { replacements: [`${TEST_PHONE_PREFIX}%`] }
    );
    res.json({ rows, prefix: TEST_PHONE_PREFIX });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/dev/reset-lead/:id — wipe a specific test lead
// ──────────────────────────────────────────────────────────────
router.post("/reset-lead/:id", async (req, res) => {
  try {
    const leadId = parseInt(req.params.id, 10);
    // Safety: only allow wiping test-prefix leads
    const [rows] = await sequelize.query(
      "SELECT phone FROM leads WHERE id = ?", { replacements: [leadId] }
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    if (!String(rows[0].phone || "").startsWith(TEST_PHONE_PREFIX)) {
      return res.status(403).json({ error: "Only test-prefix leads can be wiped via this endpoint" });
    }

    await sequelize.query("DELETE FROM messages WHERE lead_id = ?", { replacements: [leadId] });
    await sequelize.query("DELETE FROM ai_corrections WHERE reply_id IN (SELECT reply_id FROM ai_replies WHERE lead_id = ?)", { replacements: [leadId] }).catch(() => {});
    await sequelize.query("DELETE FROM ai_reply_decisions WHERE lead_id = ?", { replacements: [leadId] }).catch(() => {});
    await sequelize.query("DELETE FROM ai_replies WHERE lead_id = ?", { replacements: [leadId] });
    await sequelize.query("DELETE FROM activities WHERE lead_id = ?", { replacements: [leadId] }).catch(() => {});
    await sequelize.query("DELETE FROM events WHERE lead_id = ?", { replacements: [leadId] }).catch(() => {});
    await sequelize.query("DELETE FROM welcome_asset_sends WHERE lead_id = ?", { replacements: [leadId] }).catch(() => {});
    await sequelize.query("DELETE FROM leads WHERE id = ?", { replacements: [leadId] });

    res.json({ ok: true, leadId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/dev/mark-approved
// body: { reply_id }
// Simulates rep approving Fiza's draft WITHOUT sending to real WhatsApp.
// Triggers maybeFireEngagementAsset (which will no-op if no Baileys client).
// ──────────────────────────────────────────────────────────────
router.post("/mark-approved", async (req, res) => {
  try {
    const { reply_id } = req.body || {};
    if (!reply_id) return res.status(400).json({ error: "reply_id required" });

    const [draftRows] = await sequelize.query(
      `SELECT r.*, l.id AS lead_id, l.whatsapp_account_id, l.whatsapp_jid, l.phone
         FROM ai_replies r JOIN leads l ON l.id = r.lead_id
         WHERE r.reply_id = ?`,
      { replacements: [reply_id] }
    );
    if (!draftRows[0]) return res.status(404).json({ error: "Draft not found" });
    const draft = draftRows[0];

    // Mark sent + record as a Message row
    await sequelize.query(
      "UPDATE ai_replies SET status='sent', sent_at=NOW() WHERE reply_id = ?",
      { replacements: [reply_id] }
    );
    await sequelize.query(
      `INSERT INTO messages
         (lead_id, rep_id, whatsapp_account_id, \`from\`, message, direction,
          message_type, status, is_read, whatsapp_message_id, created_at)
       VALUES (?, NULL, ?, 'system', ?, 'OUT', 'text', 'sent', 1, ?, NOW())`,
      {
        replacements: [
          draft.lead_id, draft.whatsapp_account_id, draft.ai_response,
          `TEST_OUT_${Date.now()}`,
        ],
      }
    );
    await sequelize.query(
      "UPDATE leads SET last_message_at = NOW() WHERE id = ?",
      { replacements: [draft.lead_id] }
    );

    // Bump engagement_step (so first-touch flow progresses on next inbound)
    const lead = await loadLead(draft.lead_id);
    const newStep = Math.min((lead.engagement_step || 0) + 1, 3);
    if (newStep > (lead.engagement_step || 0)) {
      await sequelize.query(
        "UPDATE leads SET engagement_step = ? WHERE id = ?",
        { replacements: [newStep, draft.lead_id] }
      );
    }

    const refreshed = await loadLead(draft.lead_id);
    res.json({ ok: true, lead: refreshed });
  } catch (err) {
    console.error("[dev/mark-approved]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dev/trigger-followup-scan ───────────────────────
// Runs the follow-up engine's scanAndFire() RIGHT NOW so you don't
// have to wait for the every-15-min cron during testing.
// Combine with FOLLOWUP_FAST_MODE=true to fire templates after just
// silence_hours MINUTES instead of hours.
//
// Returns: { ok, fired, mode: { fast_mode, force_draft, scan_default } }
router.post("/trigger-followup-scan", async (req, res) => {
  try {
    const { scanAndFire } = require("../jobs/followupEngine");
    const io = req.app.get("io");
    const fired = await scanAndFire(io);
    res.json({
      ok: true,
      fired,
      mode: {
        fast_mode:    process.env.FOLLOWUP_FAST_MODE === "true",
        force_draft:  process.env.FOLLOWUP_FORCE_DRAFT === "true",
        scan_default: process.env.FOLLOWUP_CRON || "default",
      },
    });
  } catch (err) {
    console.error("[dev/trigger-followup-scan]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dev/peek-draft/:replyId ──────────────────────────
// Dev-only: read any ai_reply by id WITHOUT the assigned_to ownership
// check. Lets me audit Fiza drafts end-to-end during testing without
// caring which rep round-robin assigned the lead to. Guarded by
// ENABLE_DEV_SIMULATE=true. NEVER enable in production.
router.get("/peek-draft/:replyId", async (req, res) => {
  try {
    const [[draft]] = await sequelize.query(
      `SELECT r.*, l.assigned_to, l.phone, l.name,
              l.interaction_status, l.main_goal, l.last_objection,
              l.lead_score, l.funnel_stage
         FROM ai_replies r
         JOIN leads l ON l.id = r.lead_id
        WHERE r.reply_id = :id`,
      { replacements: { id: req.params.replyId } }
    );
    if (!draft) return res.status(404).json({ error: "Not found" });
    res.json(draft);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dev/peek-draft/:replyId/approve ─────────────────
// Dev-only mirror of /api/ai/drafts/:replyId/approve that doesn't
// enforce assigned_to ownership. Same logic, no auth scoping.
router.post("/peek-draft/:replyId/approve", async (req, res) => {
  try {
    const { replyId } = req.params;
    const { editedText } = req.body || {};

    const [[draft]] = await sequelize.query(
      `SELECT r.*, l.whatsapp_jid, l.whatsapp_account_id, l.assigned_to,
              l.phone, l.interaction_status, l.main_goal, l.last_objection
         FROM ai_replies r
         JOIN leads l ON l.id = r.lead_id
        WHERE r.reply_id = :id`,
      { replacements: { id: replyId } }
    );
    if (!draft) return res.status(404).json({ error: "Not found" });
    if (draft.status !== "draft" && draft.status !== "escalated") {
      return res.status(400).json({ error: `Draft already ${draft.status}` });
    }

    const wasEdited = editedText && editedText.trim() && editedText.trim() !== (draft.ai_response || "").trim();
    const finalText = wasEdited ? editedText.trim() : draft.ai_response;
    const newStatus = wasEdited ? "edited" : "sent";

    // Mark the draft sent/edited
    await sequelize.query(
      `UPDATE ai_replies
         SET status = :status,
             edited_response = :edited,
             approved_at = NOW()
       WHERE reply_id = :id`,
      {
        replacements: {
          id: replyId,
          status: newStatus,
          edited: wasEdited ? finalText : null,
        },
      }
    );

    // Bump decision counter via editCapture (Layer 5 graduation math)
    try {
      const { captureDecision } = require("../ai/editCapture");
      await captureDecision({
        replyId,
        draft,
        decision: wasEdited ? "edited" : "approved",
        finalText: wasEdited ? finalText : null,
        repId: draft.assigned_to || 0,
        leadContext: {
          interaction_status: draft.interaction_status,
          main_goal: draft.main_goal,
          last_objection: draft.last_objection,
        },
      });
    } catch { /* swallow */ }

    res.json({
      ok: true,
      reply_id: replyId,
      decision: wasEdited ? "edited" : "approved",
      final_text: finalText,
    });
  } catch (err) {
    console.error("[dev/peek-draft/approve]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dev/peek-lead/:id ────────────────────────────────
// Dev-only: dump the raw leads row including intent_history as
// stored. Used to diagnose JSON column parsing issues.
router.get("/peek-lead/:id", async (req, res) => {
  try {
    const [[row]] = await sequelize.query(
      `SELECT id, phone, name, assigned_to, stage,
              interaction_status, main_goal, last_objection, funnel_stage,
              lead_score, auto_followup_paused, last_message_at,
              last_intent_detected_at, goal_detected_at, intent_history
         FROM leads WHERE id = ?`,
      { replacements: [parseInt(req.params.id, 10)] }
    );
    if (!row) return res.status(404).json({ error: "Not found" });

    let parsed = null, parseError = null;
    if (typeof row.intent_history === "string") {
      try { parsed = JSON.parse(row.intent_history); }
      catch (e) { parseError = e.message; }
    } else {
      parsed = row.intent_history;
    }
    res.json({
      ...row,
      intent_history_type: typeof row.intent_history,
      intent_history_raw_preview: typeof row.intent_history === "string"
        ? row.intent_history.slice(0, 200)
        : null,
      intent_history_parsed_count: Array.isArray(parsed) ? parsed.length : null,
      intent_history_parse_error: parseError,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dev/peek-lead-drafts/:leadId ─────────────────────
// Dev-only: list ALL ai_replies for one lead (any status, any assignee),
// most recent first. Used in test scripts to find Layer 5 follow-up
// drafts that don't show up in token_usage (template fires, no Gemini call).
router.get("/peek-lead-drafts/:leadId", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const [rows] = await sequelize.query(
      `SELECT reply_id, lead_id, user_message, ai_response, confidence,
              escalate_reason, status, created_at
         FROM ai_replies
        WHERE lead_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
      { replacements: [parseInt(req.params.leadId, 10), limit] }
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dev/backfill-legacy-status ──────────────────────
// One-shot fix: walks every lead and sets `status` based on
// `interaction_status` using statusMap.js. Skips leads currently
// marked "converted". Useful AFTER deploying the auto-sync —
// existing leads are stuck at "new" until they get another inbound,
// so this catches them up.
router.post("/backfill-legacy-status", async (req, res) => {
  try {
    const { MAP } = require("../ai/statusMap");
    const summary = { updated: 0, by_to_status: {}, skipped_converted: 0, no_mapping: 0 };

    // Pull all leads with an interaction_status set
    const [rows] = await sequelize.query(
      `SELECT id, status, interaction_status FROM leads
        WHERE interaction_status IS NOT NULL`
    );

    for (const row of rows) {
      const target = MAP[row.interaction_status];
      if (!target) { summary.no_mapping++; continue; }
      if (row.status === "converted") { summary.skipped_converted++; continue; }
      if (row.status === target) continue;
      await sequelize.query(
        `UPDATE leads SET status = ? WHERE id = ?`,
        { replacements: [target, row.id] }
      );
      summary.updated++;
      summary.by_to_status[target] = (summary.by_to_status[target] || 0) + 1;
    }
    res.json({ ok: true, ...summary, total_scanned: rows.length });
  } catch (err) {
    console.error("[dev/backfill-legacy-status]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dev/backdate-lead/:id ───────────────────────────
// Dev-only: rewinds a lead's last_message_at by N minutes so the
// follow-up engine sees it as "silent enough" without waiting.
// Body: { minutes: number }  -> sets last_message_at = NOW() - INTERVAL N MINUTE
// Also clears intent_followup_queue rows for this lead so the
// min-gap / max-consecutive guards don't block retesting.
router.post("/backdate-lead/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const minutes = parseInt(req.body?.minutes, 10);
    if (!id || !minutes || minutes < 1) {
      return res.status(400).json({ error: "params: id (path) + minutes (body, >=1)" });
    }
    await sequelize.query(
      `UPDATE leads
          SET last_message_at = DATE_SUB(NOW(), INTERVAL ? MINUTE),
              last_activity_at = DATE_SUB(NOW(), INTERVAL ? MINUTE)
        WHERE id = ?`,
      { replacements: [minutes, minutes, id] }
    );
    // Wipe queue history so we can re-fire on the same lead
    await sequelize.query(
      `DELETE FROM intent_followup_queue WHERE lead_id = ?`,
      { replacements: [id] }
    ).catch(() => {});

    const [[lead]] = await sequelize.query(
      `SELECT id, phone, interaction_status, main_goal, last_objection,
              last_message_at, last_activity_at, auto_followup_paused
         FROM leads WHERE id = ?`,
      { replacements: [id] }
    );
    res.json({ ok: true, backdated_minutes: minutes, lead });
  } catch (err) {
    console.error("[dev/backdate-lead]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dev/followup-mode ────────────────────────────────
// Shows which test flags are active. Handy before testing.
router.get("/followup-mode", (req, res) => {
  res.json({
    fast_mode:    process.env.FOLLOWUP_FAST_MODE === "true",
    force_draft:  process.env.FOLLOWUP_FORCE_DRAFT === "true",
    cron:         process.env.FOLLOWUP_CRON || "(default)",
    dev_enabled:  process.env.ENABLE_DEV_SIMULATE === "true",
  });
});

module.exports = router;
