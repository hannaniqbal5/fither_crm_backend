/**
 * campaign.routes.js — admin endpoints for the marketing-campaign system.
 *
 *   GET    /api/campaigns                     — list campaigns
 *   POST   /api/campaigns                     — create a campaign (draft)
 *   GET    /api/campaigns/:id                 — campaign detail + stats
 *   PATCH  /api/campaigns/:id                 — update a draft
 *   DELETE /api/campaigns/:id                 — delete (drafts only)
 *
 *   GET    /api/campaigns/:id/recipients      — paginated recipient list
 *   POST   /api/campaigns/:id/import-group    — pull members from a WA group → recipients
 *   POST   /api/campaigns/:id/add-segment     — add by filter (stage, language, last_activity)
 *   POST   /api/campaigns/:id/start           — flip to 'running'
 *   POST   /api/campaigns/:id/pause           — flip to 'paused'
 *   POST   /api/campaigns/:id/abort           — kill switch
 *
 *   GET    /api/wa-groups                     — list groups the WA account is in
 *
 *   GET    /api/dnc                           — list of opted-out leads
 */

const express = require("express");
const auth    = require("../middleware/auth.middleware");
const { v4: uuidv4 } = require("uuid");
const sequelize = require("../config/database");
const { SalesRep } = require("../../models");
const { listGroups, importGroupMembers } = require("../broadcast/groupImporter");

const router = express.Router();

/**
 * scheduleToUtc — the dashboard sends a `datetime-local` value ("2026-10-25T14:30",
 * no zone) meaning Pakistan time. Interpret zone-less values as Asia/Karachi
 * (UTC+5, no DST) and return a UTC Date (stored as UTC — Sequelize's session
 * time_zone is +00:00, so the worker's `<= NOW()` compares UTC to UTC).
 * Values that carry a zone (Z / ±hh:mm) are honoured as-is.
 * Returns null for empty input; throws on an unparseable value.
 */
function scheduleToUtc(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) throw new Error("Invalid scheduled_start_at");
    return v;
  }
  const str = String(v).trim();
  if (!str) return null;
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/);
  if (m) {
    const [, y, mo, d, h = "0", mi = "0", sec = "0"] = m;
    const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec) - KARACHI_OFFSET_MS);
    if (isNaN(dt.getTime())) throw new Error("Invalid scheduled_start_at");
    return dt;
  }
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(str)) {
    const dt = new Date(str);
    if (isNaN(dt.getTime())) throw new Error("Invalid scheduled_start_at");
    return dt;
  }
  throw new Error("Invalid scheduled_start_at");
}

const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
};

// Frequency cap (days). Recently-messaged numbers are excluded when building a
// campaign's audience. Keep in sync with broadcastWorker's COOLDOWN_DAYS.
// Set CAMPAIGN_COOLDOWN_DAYS=0 in .env to disable.
const COOLDOWN_DAYS = (() => {
  const n = parseInt(process.env.CAMPAIGN_COOLDOWN_DAYS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 7;
})();
// SQL fragment (or empty) that excludes leads messaged within the cooldown window.
const COOLDOWN_EXCLUDE_SQL = COOLDOWN_DAYS > 0
  ? `AND id NOT IN (
        SELECT lead_id FROM campaign_recipients
         WHERE status IN ('sent','delivered','read','replied')
           AND sent_at IS NOT NULL
           AND sent_at >= DATE_SUB(NOW(), INTERVAL ${COOLDOWN_DAYS} DAY)
      )`
  : "";

// Numbers permanently excluded from EVERY campaign (admin / internal numbers).
// Matched on the last 10 digits so 03055124674, +92 305…, and 923055124674
// all resolve to the same number. Add more via CAMPAIGN_EXCLUDED_PHONES (comma-separated).
const { EXCLUDED_PHONE_LAST10, phoneLast10 } = (() => {
  const set = new Set(["3055124674"]); // 03055124674 — admin's own number
  (process.env.CAMPAIGN_EXCLUDED_PHONES || "").split(",").forEach((p) => {
    const d = String(p).replace(/\D/g, "");
    if (d.length >= 10) set.add(d.slice(-10));
  });
  return { EXCLUDED_PHONE_LAST10: [...set], phoneLast10: (p) => String(p || "").replace(/\D/g, "").slice(-10) };
})();
// SQL that drops those numbers from any audience build (normalises stored phone first).
const EXCLUDE_PHONES_SQL = EXCLUDED_PHONE_LAST10.length
  ? `AND RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone,''),' ',''),'+',''),'-',''),'(',''), 10)
       NOT IN (${EXCLUDED_PHONE_LAST10.map((n) => `'${n}'`).join(",")})`
  : "";

// ── Campaign sending rules (so the UI can show the active frequency cap) ──
// GET /api/campaigns/rules → { cooldown_days }
router.get("/campaigns/rules", auth, adminOnly, (req, res) => {
  res.json({ cooldown_days: COOLDOWN_DAYS });
});

// ── List active sales reps (for the campaign "Assigned sales rep" dropdown) ──
// GET /api/sales-reps → [{ id, name, email }]
router.get("/sales-reps", auth, adminOnly, async (req, res) => {
  try {
    const reps = await SalesRep.findAll({
      where: { status: "active" },
      attributes: ["id", "name", "email"],
      order: [["name", "ASC"]],
    });
    res.json(reps);
  } catch (err) {
    console.error("❌ list sales-reps:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── List groups the WA account is in ──────────────────────────
router.get("/wa-groups", auth, adminOnly, async (req, res) => {
  try {
    const accountId = parseInt(req.query.account || "1", 10);
    const groups = await listGroups(accountId);
    res.json(groups);
  } catch (err) {
    console.error("❌ [/wa-groups]:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Campaigns CRUD ───────────────────────────────────────────
router.get("/campaigns", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT campaign_id, name, channel, language, status,
              total_recipients, sent_count, delivered_count, replied_count, failed_count,
              fizza_auto_reply,
              created_at, started_at, completed_at
         FROM campaigns ORDER BY created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── "Who handles replies?" for a campaign ─────────────────────
// The admin's dropdown, stored in campaigns.replying_now (migration 039):
//   null  → "Same as rep"  — replies follow the assigned rep's Fiza level
//   "rep" → "Assist"       — Fiza drafts, the rep approves
//   "fiza"→ "Auto"         — Fiza replies on her own
// The locked guardrails in services/replyOwner.js (health, complaint,
// payment, "talk to a human") still hand those replies to the rep.
// Returns undefined for a value we don't accept.
function parseReplyMode(v) {
  if (v === "fiza" || v === "rep") return v;
  if (v === null || v === "" || v === "inherit") return null;
  return undefined;
}

// Writes the setting and keeps the legacy fizza_auto_reply flag in step, so
// the two can never disagree (replyOwner still reads the old flag as a
// fallback when replying_now is NULL).
async function setCampaignReplyMode(campaignId, mode) {
  try {
    await sequelize.query(
      "UPDATE campaigns SET replying_now = :m, fizza_auto_reply = :f WHERE campaign_id = :id",
      { replacements: { m: mode, f: mode === "fiza" ? 1 : 0, id: campaignId } }
    );
  } catch (e) {
    if (/replying_now/i.test(String(e.message || ""))) {
      throw Object.assign(
        new Error("Run migration 039 first — campaigns.replying_now doesn't exist yet"),
        { status: 503 }
      );
    }
    throw e;
  }
}

router.post("/campaigns", auth, adminOnly, async (req, res) => {
  try {
    const {
      name, description, channel = "whatsapp", language = "any",
      body, body_variants,                       // Phase 18c — variants array
      media_url,
      media_variants,                            // Per-variant media URLs (parallel to body_variants)
      delay_min_seconds = 8, delay_max_seconds = 15,
      daily_cap = 400, send_window_start = "09:00", send_window_end = "21:00",
      whatsapp_account_id = null,
      source_type = "group_import", source_meta = null,
      assigned_rep_id = null,                    // Phase 19a — rep attribution
      scheduled_start_at = null,                 // Phase 19c — schedule future start
      fizza_auto_reply = false,                  // Phase 20 — Fizza handles replies automatically
      replying_now,                              // "Who handles replies?" — null | "rep" | "fiza"
    } = req.body || {};

    if (!name || !body) {
      return res.status(400).json({ error: "name and body are required" });
    }
    const replyMode = parseReplyMode(replying_now);
    if (replying_now !== undefined && replyMode === undefined) {
      return res.status(400).json({ error: "replying_now must be null (same as rep), \"rep\" (assist) or \"fiza\" (auto)" });
    }
    let schedUtc;
    try {
      schedUtc = scheduleToUtc(scheduled_start_at);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // Phase 18c — sanitize body_variants array (1-5 non-empty strings)
    let variantsJson = null;
    if (Array.isArray(body_variants)) {
      const clean = body_variants
        .filter(v => typeof v === "string" && v.trim().length > 0)
        .map(v => v.trim())
        .slice(0, 5);
      if (clean.length > 0) variantsJson = JSON.stringify(clean);
    }

    // Per-variant media: array parallel to body_variants. Empty strings allowed
    // (means "no media for this variant"). Slice to same length as body_variants.
    let mediaVariantsJson = null;
    if (Array.isArray(media_variants)) {
      const cleanedMedia = media_variants
        .map(v => (typeof v === "string" ? v.trim() : ""))
        .slice(0, 5);
      mediaVariantsJson = JSON.stringify(cleanedMedia);
    }

    const campaignId = uuidv4();
    await sequelize.query(
      `INSERT INTO campaigns
         (campaign_id, name, description, channel, language, body, body_variants, media_url, media_variants,
          delay_min_seconds, delay_max_seconds, daily_cap,
          send_window_start, send_window_end, whatsapp_account_id, assigned_rep_id,
          fizza_auto_reply,
          scheduled_start_at,
          source_type, source_meta, status, created_by)
       VALUES
         (:id, :name, :desc, :ch, :lang, :body, :variants, :media, :mvariants,
          :dmin, :dmax, :cap,
          :ws, :we, :acc, :arep,
          :fizza,
          :sched,
          :stype, :smeta, 'draft', :rep)`,
      {
        replacements: {
          id: campaignId, name, desc: description || null, ch: channel, lang: language,
          body, variants: variantsJson, media: media_url || null, mvariants: mediaVariantsJson,
          dmin: delay_min_seconds, dmax: delay_max_seconds, cap: daily_cap,
          ws: send_window_start, we: send_window_end, acc: whatsapp_account_id,
          arep: assigned_rep_id || null,
          fizza: fizza_auto_reply ? 1 : 0,
          sched: schedUtc,
          stype: source_type, smeta: source_meta ? JSON.stringify(source_meta) : null,
          rep: req.user.repId,
        },
      }
    );

    let replyModeWarning = null;
    if (replying_now !== undefined) {
      try {
        await setCampaignReplyMode(campaignId, replyMode);
      } catch (e) {
        // The campaign itself was saved; say why the reply setting wasn't.
        replyModeWarning = e.message;
      }
    }

    const [created] = await sequelize.query(
      `SELECT * FROM campaigns WHERE campaign_id = :id`,
      { replacements: { id: campaignId } }
    );
    if (replyModeWarning) created[0].reply_mode_warning = replyModeWarning;
    res.status(201).json(created[0]);
  } catch (err) {
    console.error("❌ create campaign:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/duplicate — clone message + settings into a fresh
// draft (NO recipients copied). Admin then attaches a new group/number and starts it.
router.post("/campaigns/:id/duplicate", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT * FROM campaigns WHERE campaign_id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    );
    const src = rows[0];
    if (!src) return res.status(404).json({ error: "Campaign not found" });

    // Optional overrides at duplicate time.
    const { name: nameOverride, whatsapp_account_id: accOverride } = req.body || {};
    const newId      = uuidv4();
    const newName    = (nameOverride && String(nameOverride).trim()) || `Copy of ${src.name}`;
    const newAccount = accOverride !== undefined ? accOverride : src.whatsapp_account_id;

    // Copy content/config only. Operational fields (status, counts, schedule,
    // started/completed, weights, auto-pause) reset. body_variants/media_variants/
    // source_meta are already stored as JSON strings, so copy them verbatim.
    await sequelize.query(
      `INSERT INTO campaigns
         (campaign_id, name, description, channel, language, body, body_variants, media_url, media_variants,
          delay_min_seconds, delay_max_seconds, daily_cap,
          send_window_start, send_window_end, whatsapp_account_id, assigned_rep_id,
          fizza_auto_reply,
          scheduled_start_at,
          source_type, source_meta, status, created_by)
       VALUES
         (:id, :name, :desc, :ch, :lang, :body, :variants, :media, :mvariants,
          :dmin, :dmax, :cap,
          :ws, :we, :acc, :arep,
          :fizza,
          NULL,
          :stype, :smeta, 'draft', :rep)`,
      {
        replacements: {
          id: newId, name: newName, desc: src.description, ch: src.channel, lang: src.language,
          body: src.body, variants: src.body_variants, media: src.media_url, mvariants: src.media_variants,
          dmin: src.delay_min_seconds, dmax: src.delay_max_seconds, cap: src.daily_cap,
          ws: src.send_window_start, we: src.send_window_end, acc: newAccount, arep: src.assigned_rep_id, fizza: src.fizza_auto_reply ? 1 : 0,
          stype: src.source_type, smeta: src.source_meta,
          rep: req.user.repId,
        },
      }
    );

    // Copy "who handles replies" too (only when the source has one set;
    // a NULL source keeps the copied legacy fizza_auto_reply as-is).
    if (src.replying_now === "fiza" || src.replying_now === "rep") {
      await setCampaignReplyMode(newId, src.replying_now).catch((e) =>
        console.warn("[campaign duplicate] reply setting not copied:", e.message)
      );
    }

    const [created] = await sequelize.query(
      `SELECT * FROM campaigns WHERE campaign_id = :id`,
      { replacements: { id: newId } }
    );
    res.status(201).json({ ...created[0], duplicated_from: req.params.id });
  } catch (err) {
    console.error("❌ duplicate campaign:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/campaigns/:id", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT * FROM campaigns WHERE campaign_id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });

    // Stats: status counts
    const [statusRows] = await sequelize.query(
      `SELECT status, COUNT(*) AS n
         FROM campaign_recipients
        WHERE campaign_id = :id
        GROUP BY status`,
      { replacements: { id: req.params.id } }
    );
    const statusCounts = {};
    statusRows.forEach((r) => { statusCounts[r.status] = parseInt(r.n, 10); });

    res.json({ ...rows[0], statusCounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/campaigns/:id", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT status FROM campaigns WHERE campaign_id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    // Changing ONLY "who handles replies" is allowed while running — that's
    // exactly when an admin may need to switch a flooded campaign to Auto.
    const bodyKeys = Object.keys(req.body || {});
    const onlyReplyMode = bodyKeys.length > 0 && bodyKeys.every((k) => k === "replying_now");
    if (rows[0].status === "running" && !onlyReplyMode) {
      return res.status(400).json({ error: "Pause the campaign first before editing." });
    }
    const replyModeGiven = req.body.replying_now !== undefined;
    const replyMode = parseReplyMode(req.body.replying_now);
    if (replyModeGiven && replyMode === undefined) {
      return res.status(400).json({ error: "replying_now must be null (same as rep), \"rep\" (assist) or \"fiza\" (auto)" });
    }

    const fields = [];
    const replacements = { id: req.params.id };
    const allowed = [
      "name","description","body","media_url",
      "body_variants","media_variants",                                   // variants + per-variant media
      "delay_min_seconds","delay_max_seconds","daily_cap",
      "send_window_start","send_window_end","whatsapp_account_id","language","channel",
      "assigned_rep_id",                                                  // Phase 19a
      "fizza_auto_reply",                                                 // Phase 20
      "scheduled_start_at",                                               // Phase 19c
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        fields.push(`${k} = :${k}`);
        let val = req.body[k];
        // Auto-stringify arrays for JSON columns
        if ((k === "body_variants" || k === "media_variants") && Array.isArray(val)) {
          val = JSON.stringify(val.map(v => (typeof v === "string" ? v.trim() : "")).slice(0, 5));
        }
        if (k === "scheduled_start_at") {
          try {
            val = scheduleToUtc(val);
          } catch (e) {
            return res.status(400).json({ error: e.message });
          }
        }
        replacements[k] = val;
      }
    }
    if (fields.length === 0 && !replyModeGiven) return res.status(400).json({ error: "Nothing to update" });

    if (fields.length > 0) {
      await sequelize.query(
        `UPDATE campaigns SET ${fields.join(", ")} WHERE campaign_id = :id`,
        { replacements }
      );
    }
    // Applied after the main update so it wins over a fizza_auto_reply sent
    // in the same request.
    if (replyModeGiven) await setCampaignReplyMode(req.params.id, replyMode);
    res.json({ success: true, ...(replyModeGiven ? { replying_now: replyMode } : {}) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/campaigns/:id", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT status FROM campaigns WHERE campaign_id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    if (!["draft", "completed", "aborted"].includes(rows[0].status)) {
      return res.status(400).json({ error: "Cannot delete a running campaign" });
    }
    await sequelize.query(`DELETE FROM campaigns WHERE campaign_id = :id`, {
      replacements: { id: req.params.id },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recipients ────────────────────────────────────────────────
router.get("/campaigns/:id/recipients", auth, adminOnly, async (req, res) => {
  try {
    const status = req.query.status;
    const where = ["cr.campaign_id = :id"];
    const replacements = { id: req.params.id, limit: 200 };
    if (status) { where.push("cr.status = :status"); replacements.status = status; }

    const [rows] = await sequelize.query(
      `SELECT cr.id, cr.status, cr.sent_at, cr.replied_at, cr.error_message,
              l.id AS lead_id, l.phone, l.name, l.whatsapp_jid
         FROM campaign_recipients cr
         JOIN leads l ON l.id = cr.lead_id
        WHERE ${where.join(" AND ")}
        ORDER BY cr.id ASC
        LIMIT :limit`,
      { replacements }
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Import-from-group ─────────────────────────────────────────
router.post("/campaigns/:id/import-group", auth, adminOnly, async (req, res) => {
  try {
    const { groupJid, groupSubject } = req.body || {};
    const whatsappAccountId = Number(req.body?.whatsappAccountId) || 1; // normalize (frontend sends a string)
    if (!groupJid && !groupSubject) {
      return res.status(400).json({ error: "groupJid or groupSubject is required" });
    }

    const [campRows] = await sequelize.query(
      `SELECT status, assigned_rep_id FROM campaigns WHERE campaign_id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    );
    if (!campRows[0]) return res.status(404).json({ error: "Campaign not found" });
    if (campRows[0].status !== "draft") {
      return res.status(400).json({ error: "Recipients can only be added to drafts" });
    }

    // Step 1: import group members into leads (idempotent).
    // Phase 19a: pass campaign's assigned_rep_id so new leads inherit that rep.
    const importResult = await importGroupMembers({
      whatsappAccountId,
      groupJid,
      groupSubject,
      repId: req.user.repId,
      assignedRepId: campRows[0].assigned_rep_id || null,
    });

    // Step 2: add leads whose whatsapp_jid matches a participant of THIS group only.
    // (Earlier version pulled every lead created in the last 24h on this account,
    // which inflated recipient counts across unrelated groups.)
    const memberJids = Array.isArray(importResult.memberJids) ? importResult.memberJids : [];
    let insertedCount = 0;
    if (memberJids.length > 0) {
      const [insertResult] = await sequelize.query(
        `INSERT IGNORE INTO campaign_recipients (campaign_id, lead_id)
         SELECT :id, id FROM leads
          WHERE whatsapp_account_id = :acc
            AND whatsapp_jid IN (:jids)
            AND id NOT IN (SELECT lead_id FROM dnc_list WHERE lead_id IS NOT NULL)
            ${COOLDOWN_EXCLUDE_SQL}
            ${EXCLUDE_PHONES_SQL}`,
        { replacements: { id: req.params.id, acc: whatsappAccountId, jids: memberJids } }
      );
      insertedCount = insertResult.affectedRows || 0;
    }

    // Step 3: refresh the campaign's total_recipients
    await sequelize.query(
      `UPDATE campaigns
          SET total_recipients = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = :id),
              source_meta = JSON_SET(COALESCE(source_meta, JSON_OBJECT()),
                                      '$.group_subject', :gs,
                                      '$.group_jid', :gj)
        WHERE campaign_id = :id`,
      {
        replacements: {
          id: req.params.id,
          gs: importResult.groupSubject,
          gj: importResult.groupJid,
        },
      }
    );

    res.json({
      success: true,
      group: importResult.groupSubject,
      import: importResult.totals,
      recipientsAdded: insertedCount,
    });
  } catch (err) {
    console.error("❌ import-group:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Add by segment (filter on existing leads) ─────────────────
router.post("/campaigns/:id/add-segment", auth, adminOnly, async (req, res) => {
  try {
    const filter = req.body || {};
    const where = ["whatsapp_jid IS NOT NULL"];
    const replacements = { id: req.params.id };

    if (filter.stage)    { where.push("stage = :stage"); replacements.stage = filter.stage; }
    if (filter.language) { where.push("language = :lang"); replacements.lang = filter.language; }
    if (filter.source)   { where.push("source = :source"); replacements.source = filter.source; }
    if (filter.minLeadScore) { where.push("lead_score >= :minScore"); replacements.minScore = filter.minLeadScore; }
    if (filter.lastActivityBefore) {
      where.push("last_activity_at < :lab");
      replacements.lab = filter.lastActivityBefore;
    }

    // Don't include opted-out leads
    where.push("id NOT IN (SELECT lead_id FROM dnc_list WHERE lead_id IS NOT NULL)");

    // Don't include permanently-excluded numbers (admin / internal)
    if (EXCLUDE_PHONES_SQL) where.push(EXCLUDE_PHONES_SQL.replace(/^\s*AND\s+/, ""));

    // Don't include numbers messaged within the cooldown window
    if (COOLDOWN_DAYS > 0) {
      where.push(`id NOT IN (
        SELECT lead_id FROM campaign_recipients
         WHERE status IN ('sent','delivered','read','replied')
           AND sent_at IS NOT NULL
           AND sent_at >= DATE_SUB(NOW(), INTERVAL ${COOLDOWN_DAYS} DAY)
      )`);
    }

    const sql = `INSERT IGNORE INTO campaign_recipients (campaign_id, lead_id)
                 SELECT :id, id FROM leads WHERE ${where.join(" AND ")}`;
    const [result] = await sequelize.query(sql, { replacements });

    await sequelize.query(
      `UPDATE campaigns
          SET total_recipients = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = :id)
        WHERE campaign_id = :id`,
      { replacements: { id: req.params.id } }
    );

    res.json({ success: true, recipientsAdded: result.affectedRows || 0 });
  } catch (err) {
    console.error("❌ add-segment:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start / pause / abort ─────────────────────────────────────
router.post("/campaigns/:id/start", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT status, total_recipients, scheduled_start_at FROM campaigns WHERE campaign_id = :id`,
      { replacements: { id: req.params.id } }
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    if (rows[0].total_recipients === 0) {
      return res.status(400).json({ error: "Add recipients before starting" });
    }
    if (!["draft", "paused", "scheduled"].includes(rows[0].status)) {
      return res.status(400).json({ error: `Cannot start from status '${rows[0].status}'` });
    }

    // Phase 19c — if scheduled_start_at is in the future, flip to 'scheduled'
    // (worker will auto-promote when the time comes). Else start immediately.
    const sched = rows[0].scheduled_start_at;
    const isFutureSchedule = sched && new Date(sched) > new Date();
    const targetStatus = isFutureSchedule ? "scheduled" : "running";

    await sequelize.query(
      `UPDATE campaigns
          SET status = :status,
              started_at = CASE WHEN :status = 'running' THEN COALESCE(started_at, NOW()) ELSE started_at END
        WHERE campaign_id = :id`,
      { replacements: { id: req.params.id, status: targetStatus } }
    );
    res.json({
      success: true,
      status: targetStatus,
      ...(isFutureSchedule && { scheduled_start_at: sched }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/campaigns/:id/pause", auth, adminOnly, async (req, res) => {
  try {
    await sequelize.query(
      `UPDATE campaigns SET status = 'paused' WHERE campaign_id = :id AND status = 'running'`,
      { replacements: { id: req.params.id } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/campaigns/:id/abort", auth, adminOnly, async (req, res) => {
  try {
    await sequelize.query(
      `UPDATE campaigns SET status = 'aborted', completed_at = NOW()
        WHERE campaign_id = :id AND status IN ('running','paused','queued','draft')`,
      { replacements: { id: req.params.id } }
    );
    // Mark unsent recipients as skipped
    await sequelize.query(
      `UPDATE campaign_recipients
          SET status = 'skipped'
        WHERE campaign_id = :id AND status IN ('queued','sending')`,
      { replacements: { id: req.params.id } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Phase 19d — Manual weights recompute (testing/debug) ──────
router.post("/campaigns/recompute-weights", auth, adminOnly, async (req, res) => {
  try {
    const { recomputeWeights } = require("../broadcast/campaignWeightsJob");
    const result = await recomputeWeights();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DNC list ──────────────────────────────────────────────────
router.get("/dnc", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT d.id, d.lead_id, d.phone, d.reason, d.matched_keyword, d.created_at,
              l.name
         FROM dnc_list d
         LEFT JOIN leads l ON l.id = d.lead_id
        ORDER BY d.created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/dnc/:id", auth, adminOnly, async (req, res) => {
  try {
    await sequelize.query(`DELETE FROM dnc_list WHERE id = :id`, {
      replacements: { id: req.params.id },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/campaigns/:id/results — Phase 18 conversion analytics
// Returns the full marketing-ROI picture for a single campaign:
//   funnel counts, revenue attributed, goal breakdown, stage distribution.
// ──────────────────────────────────────────────────────────────
router.get("/campaigns/:id/results", auth, adminOnly, async (req, res) => {
  try {
    // campaign_id is a UUID string — do NOT parseInt
    const campaignId = req.params.id;
    if (!campaignId) return res.status(400).json({ error: "Invalid campaign id" });

    const [campaignRows] = await sequelize.query(
      "SELECT campaign_id, name, status, sent_count, replied_count, total_recipients, started_at, created_at FROM campaigns WHERE campaign_id = ?",
      { replacements: [campaignId] }
    );
    const campaign = campaignRows[0];
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    // 1. Funnel counts
    const [funnelRows] = await sequelize.query(
      `SELECT
         COUNT(*) AS total,
         SUM(l.stage = 'user') AS converted_users,
         SUM(l.interaction_status = 'ready_to_pay') AS ready_to_pay,
         SUM(l.lead_score >= 100) AS hot_leads,
         SUM(l.lead_score >= 60 AND l.lead_score < 100) AS warming_leads,
         SUM(l.interaction_status = 'ghosted') AS ghosted_count,
         SUM(l.interaction_status = 'opted_out') AS opted_out_count
       FROM campaign_recipients cr
       JOIN leads l ON l.id = cr.lead_id
       WHERE cr.campaign_id = ?`,
      { replacements: [campaignId] }
    );
    const funnel = funnelRows[0] || {};

    // 2. Revenue attributed
    const [revRows] = await sequelize.query(
      `SELECT
         COUNT(rc.id) AS conversions_count,
         COALESCE(SUM(rc.amount_paid), 0) AS total_revenue,
         COALESCE(AVG(rc.amount_paid), 0) AS avg_deal,
         MIN(rc.converted_at) AS first_conversion_at,
         MAX(rc.converted_at) AS last_conversion_at
       FROM campaign_recipients cr
       JOIN rep_conversions rc ON rc.lead_id = cr.lead_id
       WHERE cr.campaign_id = ?`,
      { replacements: [campaignId] }
    );
    const revenue = revRows[0] || {};

    // 3. Goal breakdown
    const [byGoal] = await sequelize.query(
      `SELECT COALESCE(l.main_goal, 'unknown') AS main_goal, COUNT(*) AS count
       FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id
       WHERE cr.campaign_id = ? GROUP BY l.main_goal ORDER BY count DESC`,
      { replacements: [campaignId] }
    );

    // 4. Funnel stage distribution
    const [byStage] = await sequelize.query(
      `SELECT COALESCE(l.funnel_stage, 1) AS funnel_stage, COUNT(*) AS count
       FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id
       WHERE cr.campaign_id = ? GROUP BY l.funnel_stage ORDER BY funnel_stage`,
      { replacements: [campaignId] }
    );

    // 5. Interaction status distribution
    const [byStatus] = await sequelize.query(
      `SELECT COALESCE(l.interaction_status, 'no_status') AS interaction_status, COUNT(*) AS count
       FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id
       WHERE cr.campaign_id = ? GROUP BY l.interaction_status ORDER BY count DESC LIMIT 15`,
      { replacements: [campaignId] }
    );

    // 6. Objections distribution
    const [byObjection] = await sequelize.query(
      `SELECT COALESCE(l.last_objection, 'none') AS last_objection, COUNT(*) AS count
       FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id
       WHERE cr.campaign_id = ? GROUP BY l.last_objection ORDER BY count DESC`,
      { replacements: [campaignId] }
    );

    // 7. Time-to-first-sale (hours)
    let timeToFirstSale = null;
    if (campaign.started_at && revenue.first_conversion_at) {
      timeToFirstSale = Math.round(
        (new Date(revenue.first_conversion_at) - new Date(campaign.started_at)) / 3600000
      );
    }

    // 8. Computed rates
    const sent = Number(campaign.sent_count || 0);
    const replied = Number(campaign.replied_count || 0);
    const converted = Number(revenue.conversions_count || 0);

    res.json({
      campaign,
      funnel,
      revenue,
      rates: {
        reply_rate_pct:                  sent > 0 ? +(replied / sent * 100).toFixed(2) : 0,
        conversion_rate_of_sent_pct:     sent > 0 ? +(converted / sent * 100).toFixed(2) : 0,
        conversion_rate_of_replied_pct:  replied > 0 ? +(converted / replied * 100).toFixed(1) : 0,
      },
      breakdowns: {
        by_goal: byGoal,
        by_funnel_stage: byStage,
        by_interaction_status: byStatus,
        by_objection: byObjection,
      },
      time_to_first_sale_hours: timeToFirstSale,
    });
  } catch (err) {
    console.error("[campaign results]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/campaigns/analytics/summary
// Cross-campaign rollup — totals, top performers, comparison rows.
// ──────────────────────────────────────────────────────────────
router.get("/campaigns/analytics/summary", auth, adminOnly, async (req, res) => {
  try {
    const [totalsRows] = await sequelize.query(
      `SELECT
         COUNT(*)                                              AS total_campaigns,
         SUM(CASE WHEN status = 'running'   THEN 1 ELSE 0 END) AS running_count,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
         SUM(CASE WHEN status = 'draft'     THEN 1 ELSE 0 END) AS draft_count,
         COALESCE(SUM(total_recipients), 0) AS total_recipients,
         COALESCE(SUM(sent_count), 0)       AS total_sent,
         COALESCE(SUM(replied_count), 0)    AS total_replied,
         COALESCE(SUM(failed_count), 0)     AS total_failed
       FROM campaigns`
    );
    const totals = totalsRows[0] || {};

    const [revRows] = await sequelize.query(
      `SELECT
         COUNT(DISTINCT rc.id)                AS total_conversions,
         COALESCE(SUM(rc.amount_paid), 0)     AS total_revenue,
         COALESCE(AVG(rc.amount_paid), 0)     AS avg_deal
       FROM campaign_recipients cr
       JOIN rep_conversions rc ON rc.lead_id = cr.lead_id
       JOIN campaigns c ON c.campaign_id = cr.campaign_id
       WHERE rc.converted_at >= COALESCE(c.started_at, c.created_at)`
    );
    const revenue = revRows[0] || {};

    const [perCampaign] = await sequelize.query(
      `SELECT
         c.campaign_id, c.name, c.status, c.channel,
         c.total_recipients, c.sent_count, c.replied_count, c.failed_count,
         c.started_at, c.completed_at,
         CASE WHEN c.sent_count > 0
              THEN ROUND(c.replied_count / c.sent_count * 100, 1)
              ELSE 0 END AS reply_rate_pct,
         (SELECT COUNT(DISTINCT rc.id)
            FROM campaign_recipients cr
            JOIN rep_conversions rc ON rc.lead_id = cr.lead_id
           WHERE cr.campaign_id = c.campaign_id
             AND rc.converted_at >= COALESCE(c.started_at, c.created_at)
         ) AS conversions,
         (SELECT COALESCE(SUM(rc.amount_paid), 0)
            FROM campaign_recipients cr
            JOIN rep_conversions rc ON rc.lead_id = cr.lead_id
           WHERE cr.campaign_id = c.campaign_id
             AND rc.converted_at >= COALESCE(c.started_at, c.created_at)
         ) AS revenue
       FROM campaigns c
       ORDER BY c.created_at DESC
       LIMIT 20`
    );

    const sentCampaigns = perCampaign.filter(c => Number(c.sent_count) > 0);
    const topByReply = [...sentCampaigns]
      .sort((a, b) => Number(b.reply_rate_pct) - Number(a.reply_rate_pct))[0] || null;
    const topByRevenue = [...sentCampaigns]
      .sort((a, b) => Number(b.revenue) - Number(a.revenue))[0] || null;

    const [channelMix] = await sequelize.query(
      `SELECT channel, COUNT(*) AS n
         FROM campaigns
        WHERE status IN ('running','completed','paused','aborted')
        GROUP BY channel`
    );

    const sent = Number(totals.total_sent || 0);
    const replied = Number(totals.total_replied || 0);
    const conversions = Number(revenue.total_conversions || 0);

    res.json({
      totals: {
        ...totals,
        total_conversions: conversions,
        total_revenue: Number(revenue.total_revenue || 0),
        avg_deal: Number(revenue.avg_deal || 0),
        overall_reply_rate_pct:     sent > 0 ? +(replied / sent * 100).toFixed(1) : 0,
        overall_conversion_rate_pct: sent > 0 ? +(conversions / sent * 100).toFixed(2) : 0,
      },
      top_performers: {
        by_reply_rate: topByReply,
        by_revenue:    topByRevenue,
      },
      per_campaign: perCampaign,
      channel_mix:  channelMix,
    });
  } catch (err) {
    console.error("[campaigns analytics summary]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/campaigns/:id/retry-failed
// Requeues all status='failed' recipients, resets their error_message,
// recalculates failed_count, and flips the campaign back to 'running'.
// Use after fixing the issue that caused failures (bad media URL, etc.)
// ──────────────────────────────────────────────────────────────
router.post("/campaigns/:id/retry-failed", auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT status, failed_count FROM campaigns WHERE campaign_id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    if (rows[0].status === "running") {
      return res.status(400).json({ error: "Campaign is already running" });
    }

    // Requeue failed AND skipped recipients (skipped happens when worker
    // bailed mid-flight or couldn't resolve a phone — worth re-attempting
    // after a session refresh or config change)
    const [updateResult] = await sequelize.query(
      `UPDATE campaign_recipients
          SET status = 'queued',
              error_message = NULL,
              sent_at = NULL
        WHERE campaign_id = :id AND status IN ('failed', 'skipped')`,
      { replacements: { id: req.params.id } }
    );
    const requeued = updateResult.affectedRows || 0;

    // Decrement failed_count by the requeued count, flip campaign to running
    await sequelize.query(
      `UPDATE campaigns
          SET status        = 'running',
              completed_at  = NULL,
              failed_count  = GREATEST(0, COALESCE(failed_count, 0) - :n)
        WHERE campaign_id = :id`,
      { replacements: { id: req.params.id, n: requeued } }
    );

    res.json({ success: true, requeued });
  } catch (err) {
    console.error("[retry-failed]", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
