/**
 * ai.routes.js — Sales-rep + admin endpoints for the AI agent.
 *
 *   GET    /api/ai/drafts                — pending drafts assigned to current rep
 *   GET    /api/ai/drafts/:replyId       — single draft details
 *   POST   /api/ai/drafts/:replyId/approve  — rep approves & sends (optional editedText)
 *   POST   /api/ai/drafts/:replyId/reject   — rep rejects, replies manually
 *   POST   /api/ai/ingest               — admin: re-run ingestion (after editing KB)
 *   GET    /api/ai/stats                — admin: AI activity stats (last 7d)
 *   GET    /api/ai/corrections?limit=20 — admin: recent rep corrections of AI drafts
 */

const express = require("express");
const auth    = require("../middleware/auth.middleware");
const { v4: uuidv4 } = require("uuid");

const sequelize = require("../config/database");
const channelRouter = require("../channels/channelRouter");
const { invalidateCache } = require("../ai/retrieval.service");
const { captureDecision } = require("../ai/editCapture");

async function loadLeadContext(leadId) {
  try {
    const [rows] = await sequelize.query(
      "SELECT interaction_status, main_goal, last_objection FROM leads WHERE id = ?",
      { replacements: [leadId] }
    );
    return rows[0] || {};
  } catch { return {}; }
}

const router = express.Router();

// ── Admin guard middleware ─────────────────────────────────────
const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
};

// ─── GET /api/ai/drafts ─────────────────────────────────────────
// Pending AI drafts for the current rep's leads.
router.get("/drafts", auth, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT r.reply_id, r.lead_id, r.user_message, r.ai_response,
              r.confidence, r.escalate_reason, r.status, r.created_at,
              l.phone, l.name, l.stage
         FROM ai_replies r
         JOIN leads l ON l.id = r.lead_id
        WHERE r.status IN ('draft','escalated')
          AND l.assigned_to = :repId
        ORDER BY r.created_at DESC
        LIMIT 50`,
      { replacements: { repId: req.user.repId } }
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ [AI Routes] /drafts error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/ai/drafts/:replyId ────────────────────────────────
router.get("/drafts/:replyId", auth, async (req, res) => {
  try {
    const [[draft]] = await sequelize.query(
      `SELECT r.*, l.assigned_to, l.phone, l.name
         FROM ai_replies r
         JOIN leads l ON l.id = r.lead_id
        WHERE r.reply_id = :id`,
      { replacements: { id: req.params.replyId } }
    );
    if (!draft) return res.status(404).json({ error: "Not found" });
    if (draft.assigned_to !== req.user.repId && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not your lead" });
    }
    res.json(draft);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ai/drafts/:replyId/approve ───────────────────────
// Rep approves the AI draft (optionally edits) and sends it.
router.post("/drafts/:replyId/approve", auth, async (req, res) => {
  try {
    const { replyId } = req.params;
    const { editedText } = req.body || {};

    const [[draft]] = await sequelize.query(
      `SELECT r.*, l.id AS leadId, l.assigned_to, l.source,
              l.whatsapp_jid, l.whatsapp_account_id, l.phone,
              l.instagram_psid, l.facebook_psid, l.meta_page_id
         FROM ai_replies r
         JOIN leads l ON l.id = r.lead_id
        WHERE r.reply_id = :id`,
      { replacements: { id: replyId } }
    );

    if (!draft) return res.status(404).json({ error: "Draft not found" });
    if (draft.status !== "draft" && draft.status !== "escalated") {
      return res.status(400).json({ error: `Draft already in status '${draft.status}'` });
    }
    if (draft.assigned_to !== req.user.repId && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not your lead" });
    }

    const original  = String(draft.ai_response || "");
    const wasEdited = !!(editedText && String(editedText).trim() && String(editedText).trim() !== original.trim());
    const finalText = wasEdited ? String(editedText).trim() : original;
    if (!finalText.trim()) {
      return res.status(400).json({ error: "Draft is empty — edit it before sending" });
    }

    // Atomically claim the draft (draft/escalated → sending) so a double-click
    // or two reps can never send the same reply twice.
    const prevStatus = draft.status;
    const [claim] = await sequelize.query(
      `UPDATE ai_replies SET status = 'sending'
        WHERE reply_id = :id AND status = :prev`,
      { replacements: { id: replyId, prev: prevStatus } }
    );
    if (!claim || !claim.affectedRows) {
      return res.status(409).json({ error: "Draft is already being sent or was handled" });
    }
    const releaseClaim = async (errMsg) => {
      try {
        await sequelize.query(
          `UPDATE ai_replies SET status = :prev, error_message = :err
            WHERE reply_id = :id AND status = 'sending'`,
          { replacements: { id: replyId, prev: prevStatus, err: errMsg ? String(errMsg).slice(0, 1000) : null } }
        );
      } catch (e) {
        console.error(`❌ [AI Routes] could not release claim on ${replyId}:`, e.message);
      }
    };

    let sendResult;
    const isFollowup = String(draft.user_message || "").startsWith("[layer5_followup:");
    try {
      // Follow-up drafts are PROACTIVE — they must pass the send gate (opt-out /
      // DNC always block; other rules block only in enforce mode).
      if (isFollowup) {
        const { canSendProactive } = require("../services/sendGate");
        const ctx = await loadLeadContext(draft.leadId);
        const gate = await canSendProactive(
          { id: draft.leadId, interaction_status: ctx.interaction_status },
          { accountId: draft.whatsapp_account_id }
        );
        if (!gate.allowed) {
          await releaseClaim(`Gate: ${gate.reason}`);
          return res.status(403).json({ error: "Blocked by send gate", reason: gate.reason });
        }
      }

      // Reconstruct minimal "person" shape for channelRouter.send()
      const personLike = {
        id: draft.leadId,
        source: draft.source,
        whatsapp_jid: draft.whatsapp_jid,
        whatsapp_account_id: draft.whatsapp_account_id,
        phone: draft.phone,
        instagram_psid: draft.instagram_psid,
        facebook_psid:  draft.facebook_psid,
        meta_page_id:   draft.meta_page_id,
      };

      // Route to whatever channel the lead came in on (whatsapp / facebook / instagram)
      sendResult = await channelRouter.send(personLike, finalText, "any");
    } catch (e) {
      await releaseClaim(e.message);
      throw e;
    }
    if (!sendResult || !sendResult.success) {
      // Back to its previous status so the rep can retry.
      await releaseClaim(sendResult?.error || "send failed");
      return res.status(500).json({ error: "Channel send failed", detail: sendResult?.error, channel: sendResult?.channel });
    }

    // Sent — record the final status right away so a later error can never
    // leave the reply stuck in 'sending' (or make it re-sendable).
    const newStatus = wasEdited ? "edited" : "sent";
    await sequelize.query(
      `UPDATE ai_replies
          SET status = :status,
              edited_response = :edited,
              sent_at = NOW(),
              rep_id = :repId,
              feedback = :feedback
        WHERE reply_id = :id`,
      {
        replacements: {
          status:   newStatus,
          edited:   wasEdited ? finalText : null,
          repId:    req.user.repId,
          feedback: wasEdited ? "fix" : "good",
          id:       replyId,
        },
      }
    );
    if (isFollowup) {
      try {
        const { logProactiveSend } = require("../services/sendGate");
        const tk = (String(draft.user_message).match(/^\[layer5_followup:([^\]]+)\]/) || [])[1] || null;
        await logProactiveSend({ leadId: draft.leadId, accountId: draft.whatsapp_account_id, source: "followup", templateKey: tk });
      } catch (e) {
        console.error("⚠️  [AI Routes] logProactiveSend failed:", e.message);
      }
    }

    // Persist the outbound message so the rep's chat history shows it
    const channelUsed = sendResult.channel || "whatsapp";
    const externalId  = sendResult.messageId || null;

    const [insertOut] = await sequelize.query(
      `INSERT INTO messages (
         lead_id, rep_id, whatsapp_account_id,
         \`from\`, channel, external_message_id,
         message, direction, message_type, status, is_read,
         whatsapp_message_id, created_at
       ) VALUES (
         :leadId, :repId, :waAccountId,
         'rep', :channel, :externalId,
         :text, 'OUT', 'text', 'sent', 1,
         :waMsgId, NOW()
       )`,
      {
        replacements: {
          leadId:      draft.leadId,
          repId:       req.user.repId,
          waAccountId: channelUsed === "whatsapp" ? draft.whatsapp_account_id : null,
          channel:     channelUsed,
          externalId,
          text:        finalText,
          waMsgId:     channelUsed === "whatsapp" ? externalId : null,
        },
      }
    );
    const outMessageId = insertOut.insertId;

    // Bump lead's last_message_at so it sorts to the top
    await sequelize.query(
      `UPDATE leads SET last_message_at = NOW() WHERE id = :id`,
      { replacements: { id: draft.leadId } }
    );

    // Real-time push to rep dashboard so the message appears in chat instantly
    try {
      const io = req.app.get("io");
      if (io && draft.assigned_to) {
        io.to(`rep_${draft.assigned_to}`).emit("newMessage", {
          id: outMessageId,
          lead_id: draft.leadId,
          rep_id: req.user.repId,
          from: "rep",
          channel: channelUsed,
          message: finalText,
          direction: "OUT",
          message_type: "text",
          status: "sent",
          is_read: 1,
          whatsapp_message_id: channelUsed === "whatsapp" ? externalId : null,
          external_message_id: externalId,
          created_at: new Date().toISOString(),
        });
      }
    } catch (emitErr) {
      console.warn(`⚠️  [AI Routes] socket emit failed: ${emitErr.message}`);
    }

    // Phase 11 — capture decision with full context + counters
    try {
      const leadContext = await loadLeadContext(draft.leadId);
      await captureDecision({
        replyId,
        draft: { ...draft, lead_id: draft.leadId },
        decision: wasEdited ? "edited" : "approved",
        finalText: wasEdited ? finalText : null,
        repId: req.user.repId,
        leadContext,
      });
    } catch (e) {
      console.error("⚠️  [AI Routes] capture failed:", e.message);
    }

    // Phase 15c — fire voice/poster engagement asset after rep-approved send (WA only)
    if (channelUsed === "whatsapp") {
      try {
        const { maybeFireEngagementAsset } = require("../services/firstTouch.service");
        const { People } = require("../../models");
        const freshPerson = await People.findByPk(draft.leadId);
        if (freshPerson) {
          const io = req.app.get("io");
          maybeFireEngagementAsset(freshPerson, io).catch(() => {});
        }
      } catch (e) {
        console.error("⚠️  [AI Routes] firstTouch fire failed:", e.message);
      }
    }

    res.json({
      success: true,
      sent: true,
      edited: wasEdited,
      channel: channelUsed,
      messageId: sendResult.messageId,
      whatsappMessageId: channelUsed === "whatsapp" ? sendResult.messageId : null,
    });
  } catch (err) {
    console.error("❌ [AI Routes] /approve error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ai/drafts/:replyId/reject ────────────────────────
// Rep rejects the draft (will reply manually).
router.post("/drafts/:replyId/reject", auth, async (req, res) => {
  try {
    const { replyId } = req.params;
    const { reason } = req.body || {};

    const [[draft]] = await sequelize.query(
      `SELECT r.*, l.assigned_to FROM ai_replies r
         JOIN leads l ON l.id = r.lead_id
        WHERE r.reply_id = :id`,
      { replacements: { id: replyId } }
    );
    if (!draft) return res.status(404).json({ error: "Not found" });
    if (draft.assigned_to !== req.user.repId && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not your lead" });
    }

    // Only a pending draft can be rejected (never one already sent/sending).
    const [rej] = await sequelize.query(
      `UPDATE ai_replies
          SET status = 'rejected',
              rep_id = :repId,
              feedback = 'fix',
              error_message = :reason
        WHERE reply_id = :id AND status IN ('draft','escalated')`,
      {
        replacements: {
          repId: req.user.repId,
          reason: reason || null,
          id: replyId,
        },
      }
    );
    if (!rej || !rej.affectedRows) {
      return res.status(409).json({ error: `Draft already in status '${draft.status}'` });
    }

    // Phase 11 — capture rejection
    try {
      const leadContext = await loadLeadContext(draft.lead_id);
      await captureDecision({
        replyId,
        draft,
        decision: "rejected",
        rejectReason: reason,
        repId: req.user.repId,
        leadContext,
      });
    } catch (e) {
      console.error("⚠️  [AI Routes] reject capture failed:", e.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ [AI Routes] /reject error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ai/ingest ────────────────────────────────────────
// Admin: re-runs knowledge-base ingestion. Returns immediately;
// ingestion runs in background.
router.post("/ingest", auth, adminOnly, async (req, res) => {
  try {
    const { ingest } = require("../ai/ingest.script");
    invalidateCache();

    // Fire and forget — ingestion can take 1-3 minutes on large KBs.
    ingest()
      .then(() => console.log("✅ [AI Routes] Manual ingestion completed"))
      .catch(e => console.error("❌ [AI Routes] Manual ingestion failed:", e.message));

    res.json({ success: true, message: "Ingestion started in background" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/ai/stats ──────────────────────────────────────────
// Admin: 7-day activity summary.
router.get("/stats", auth, adminOnly, async (req, res) => {
  try {
    const [stats] = await sequelize.query(`
      SELECT
        COUNT(*) AS total_drafts,
        SUM(status = 'edited')    AS sent_after_edit,
        SUM(status = 'rejected')  AS rejected,
        SUM(status = 'escalated') AS escalated,
        SUM(status = 'failed')    AS failed,
        AVG(confidence)           AS avg_confidence
      FROM ai_replies
      WHERE created_at >= NOW() - INTERVAL 7 DAY
    `);

    const [chunkCount] = await sequelize.query(
      `SELECT COUNT(*) AS chunks FROM kb_chunks`
    );

    res.json({
      window: "last_7_days",
      ...stats[0],
      kb_chunks: chunkCount[0].chunks,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/ai/corrections?limit=20 ───────────────────────────
// Admin: most recent rep corrections of AI drafts (AdminAITab).
router.get("/corrections", auth, adminOnly, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const [rows] = await sequelize.query(
      `SELECT correction_id, reply_id, rep_id, original_reply, corrected_reply,
              notes, edit_action, edit_distance, interaction_status, main_goal,
              last_objection, user_message, promoted, dismissed, created_at
         FROM ai_corrections
        ORDER BY created_at DESC
        LIMIT ${limit}`
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ [AI Routes] /corrections error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
