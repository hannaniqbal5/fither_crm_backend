/**
 * fizzaChats.routes.js — Phase 21: Fizza Chats admin view.
 *
 * Lets admins:
 *   1. See all leads where Fizza has had conversations (AI-handled chats)
 *   2. Open any chat and read the full message history
 *   3. Send a WhatsApp message to any number to test Fizza live
 *
 * Routes (all behind auth + adminOnly):
 *   GET  /api/admin/fizza-chats           — list leads with AI replies (paginated)
 *   GET  /api/admin/fizza-chats/:leadId   — full message history for a lead
 *   POST /api/admin/fizza-chats/:leadId/reply — admin replies on HER channel
 *        (app chat + push, WhatsApp, Instagram or Facebook — wherever she last wrote)
 *   POST /api/admin/fizza-chats/send      — send a WhatsApp text to a number (admin test)
 */
const express = require("express");
const auth = require("../middleware/auth.middleware");
const sequelize = require("../config/database");

const router = express.Router();

// Admin role guard
function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

router.use(auth);
router.use(adminOnly);

/* ───────────────────────────────────────────────
   GET /api/admin/fizza-chats
   List leads with a WhatsApp conversation (existing numbers), AI stats optional.
   Query params: page (default 1), limit (default 50), search (phone/name)
─────────────────────────────────────────────── */
router.get("/", async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (req.query.search || "").trim();

    let whereClause = "WHERE l.merged_into_lead_id IS NULL";
    const replacements = { limit, offset };

    if (search) {
      // Searching: match ANY existing lead by number or name, even if Fizza
      // hasn't chatted with them yet — so you can start a new chat.
      const digits = String(search).replace(/[^0-9]/g, "");
      // Email matters here: a woman who reached us through the app chat may
      // have signed in with Google or Apple and have no phone number at all,
      // so name and phone alone can't find her.
      const parts = ["l.name LIKE :namesearch", "l.email LIKE :namesearch"];
      replacements.namesearch = `%${search}%`;
      if (digits) {
        // Normalize the stored phone to digits only so separators/format don't matter.
        const cleanPhone =
          "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(l.phone,'+',''),' ',''),'-',''),'(',''),')','')";
        parts.push(`${cleanPhone} LIKE :search`);
        replacements.search = `%${digits}%`;
        // Also match on the national part (last 10 digits) so a missing/extra
        // country code (e.g. 92) still finds the lead.
        const last10 = digits.slice(-10);
        if (last10 && last10 !== digits) {
          parts.push(`${cleanPhone} LIKE :searchTail`);
          replacements.searchTail = `%${last10}%`;
        }
      }
      whereClause += " AND (" + parts.join(" OR ") + ")";
    } else {
      // No search: show leads that already have a WhatsApp conversation.
      whereClause += " AND EXISTS (SELECT 1 FROM messages mx WHERE mx.lead_id = l.id)";
    }

    // List leads that have a WhatsApp conversation (AI stats attached when present)
    const [[{ total }]] = await sequelize.query(
      `SELECT COUNT(*) AS total
         FROM leads l
        ${whereClause}`,
      { replacements }
    );

    const [rows] = await sequelize.query(
      `SELECT
         l.id, l.phone, l.email, l.name, l.stage, l.lead_score,
         l.app_user_id, l.source,
         CASE WHEN l.stage = 'user' THEN 'paid' ELSE l.stage END AS category,
         l.interaction_status, l.main_goal, l.assigned_to,
         l.last_message_at, l.unread_count,
         sr.name AS rep_name,
         COALESCE(stats.total_replies, 0) AS total_replies,
         COALESCE(stats.auto_sent, 0)     AS auto_sent,
         COALESCE(stats.last_ai_at, l.last_message_at) AS last_ai_at,
         last_msg.message AS last_message,
         last_msg.direction AS last_direction
       FROM leads l
       LEFT JOIN (
         SELECT ar2.lead_id,
                COUNT(*) AS total_replies,
                SUM(CASE WHEN ar2.status = 'sent' THEN 1 ELSE 0 END) AS auto_sent,
                MAX(ar2.created_at) AS last_ai_at
           FROM ai_replies ar2
          GROUP BY ar2.lead_id
       ) stats ON stats.lead_id = l.id
       LEFT JOIN sales_reps sr ON sr.id = l.assigned_to
       LEFT JOIN messages last_msg ON last_msg.id = (
         SELECT m2.id FROM messages m2 WHERE m2.lead_id = l.id ORDER BY m2.id DESC LIMIT 1
       )
       ${whereClause}
       ORDER BY COALESCE(stats.last_ai_at, l.last_message_at) DESC
       LIMIT :limit OFFSET :offset`,
      { replacements }
    );

    // Who is answering each chat. Fetched separately and merged, because one
    // missing column in the big query above would break the whole list — and
    // this one only exists after migration 039.
    if (rows.length) {
      try {
        const ids = rows.map((r) => r.id);
        const [over] = await sequelize.query(
          "SELECT id, replying_now FROM leads WHERE id IN (:ids)",
          { replacements: { ids } }
        );
        const byId = new Map(over.map((o) => [Number(o.id), o.replying_now]));
        for (const r of rows) r.replying_now = byId.get(Number(r.id)) ?? null;
      } catch (e) {
        if (!/replying_now/i.test(String(e.message || ""))) {
          console.warn("[fizza-chats] replying_now lookup failed:", e.message);
        }
        for (const r of rows) r.replying_now = null;
      }
    }

    res.json({
      leads: rows,
      total: parseInt(total),
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[fizza-chats] list error:", err);
    res.status(500).json({ error: "Failed to load Fizza chats" });
  }
});

/* ───────────────────────────────────────────────
   GET /api/admin/fizza-chats/:leadId
   Full message history for a lead + AI reply metadata.
─────────────────────────────────────────────── */
router.get("/:leadId", async (req, res) => {
  try {
    const leadId = parseInt(req.params.leadId);
    if (!leadId) return res.status(400).json({ error: "Invalid lead ID" });

    // Lead info
    const [[lead]] = await sequelize.query(
      `SELECT l.*,
              CASE WHEN l.stage = 'user' THEN 'paid' ELSE l.stage END AS category,
              sr.name AS rep_name
         FROM leads l
         LEFT JOIN sales_reps sr ON sr.id = l.assigned_to
        WHERE l.id = :leadId`,
      { replacements: { leadId } }
    );
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    // Messages (last 200)
    const [messages] = await sequelize.query(
      `SELECT m.id, m.message, m.direction, m.status, m.message_type,
              m.media_url, m.media_mime, m.file_name, m.duration,
              m.channel,
              m.voice_transcript, m.created_at, m.\`from\`,
              m.rep_id, srm.name AS sender_name, srm.role AS sender_role,
              ar.confidence, ar.escalate_reason, ar.status AS ai_status
         FROM messages m
         LEFT JOIN ai_replies ar ON ar.message_id = m.id AND m.direction = 'IN'
         LEFT JOIN sales_reps srm
                ON srm.id = m.rep_id AND m.direction = 'OUT' AND m.\`from\` = 'rep'
        WHERE m.lead_id = :leadId
        ORDER BY m.id ASC
        LIMIT 200`,
      { replacements: { leadId } }
    );

    // AI stats for this lead
    const [[aiStats]] = await sequelize.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN status = 'edited' THEN 1 ELSE 0 END) AS edited,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              AVG(confidence) AS avg_confidence
         FROM ai_replies
        WHERE lead_id = :leadId`,
      { replacements: { leadId } }
    );

    // Where a reply from this screen would go, so the box can say so.
    const reply_channel = await replyChannelFor(lead);
    res.json({ lead, messages, aiStats, reply_channel });
  } catch (err) {
    console.error("[fizza-chats] detail error:", err);
    res.status(500).json({ error: "Failed to load chat" });
  }
});

/* ───────────────────────────────────────────────
   POST /api/admin/fizza-chats/send
   Send a WhatsApp message from admin to test Fizza.
   Body: { phone, message, whatsapp_account_id? }

   This sends a real outbound WhatsApp message, so when the
   person replies, the reply flows through the normal pipeline
   and Fizza handles it.
─────────────────────────────────────────────── */
/* ───────────────────────────────────────────────
   Admin reply — on HER channel.
   The reply goes the way she last wrote to us: app chat, WhatsApp, Instagram
   or Facebook. If her last channel can't be reached any more, the first one
   we can reach is used (WhatsApp, then app, then Instagram, then Facebook).
   It is saved as a person's message ('rep') under the admin's name, so:
     • it shows in her app chat as "coach" and in the CRM as "👑 Admin · name";
     • Fizza stays quiet on this chat for 24 h (a person is talking), until an
       admin clicks "Give to Fizza".
─────────────────────────────────────────────── */
const REPLY_CHANNEL_LABEL = {
  app: "the Fit Her app",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook",
};

async function replyChannelFor(lead) {
  if (!lead) return null;
  const can = {
    app:       !!lead.app_user_id,
    whatsapp:  !!lead.whatsapp_jid,
    instagram: !!lead.instagram_psid,
    facebook:  !!lead.facebook_psid,
  };
  try {
    const [[lastIn]] = await sequelize.query(
      "SELECT channel FROM messages WHERE lead_id = :id AND direction = 'IN' ORDER BY id DESC LIMIT 1",
      { replacements: { id: lead.id } }
    );
    // Old WhatsApp rows have channel NULL; treat that as WhatsApp.
    const last = lastIn ? (lastIn.channel || "whatsapp") : null;
    if (last && can[last]) return last;
  } catch (_) { /* fall back to the first reachable channel */ }
  for (const ch of ["whatsapp", "app", "instagram", "facebook"]) if (can[ch]) return ch;
  return null;
}

// Push "your coach replied" to her phone (signed; services/appPush.js).
async function pushToApp(lead, text) {
  const { pushToApp: push } = require("../services/appPush");
  const r = await push({
    appUserId: lead.app_user_id,
    title: "Your coach replied 💬",
    body: String(text).slice(0, 200),
    data: { type: "coach_chat", lead_id: String(lead.id) },
  });
  return r.pushed;
}

router.post("/:leadId/reply", async (req, res) => {
  try {
    const leadId = parseInt(req.params.leadId);
    const text = String((req.body && req.body.message) || "").trim().slice(0, 4000);
    if (!leadId) return res.status(400).json({ error: "Invalid lead ID" });
    if (!text) return res.status(400).json({ error: "message is required" });

    const [[lead]] = await sequelize.query(
      "SELECT * FROM leads WHERE id = :id AND merged_into_lead_id IS NULL LIMIT 1",
      { replacements: { id: leadId } }
    );
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const channel = await replyChannelFor(lead);
    if (!channel) {
      return res.status(400).json({ error: "She has no app account, WhatsApp, Instagram or Facebook to reply to." });
    }

    const frontDesk = require("../services/frontDesk");
    let externalId = null;
    if (channel !== "app") {
      // She asked us to stop (STOP / do-not-contact): nothing goes out on
      // WhatsApp / Instagram / Facebook. The in-app chat is hers to use.
      if (await frontDesk.isSilenced(lead)) {
        return res.status(409).json({ error: "She opted out (STOP / do-not-contact), so nothing was sent." });
      }
      const result = channel === "whatsapp"
        ? await require("../channels/whatsappChannel").send(lead, text)
        : await require("../channels/channelRouter").send(lead, text, channel);
      if (!result || !result.success) {
        return res.status(502).json({ error: `Couldn't send on ${REPLY_CHANNEL_LABEL[channel]}: ${(result && result.error) || "unknown error"}` });
      }
      externalId = result.messageId || null;
    }

    const adminRepId = req.user.repId;
    const { message } = await frontDesk.saveMessage({
      contact: lead,
      direction: "OUT",
      channel,
      from: "rep",
      text,
      accountId: lead.whatsapp_account_id || 1,
      externalMessageId: externalId,
      externalThreadId: channel === "instagram" ? lead.instagram_psid
                      : channel === "facebook" ? lead.facebook_psid : null,
      repId: adminRepId,
    });

    const pushed = channel === "app" ? await pushToApp(lead, text) : null;

    // The full row, with the admin's name, for both screens.
    const [[row]] = await sequelize.query(
      `SELECT m.*, srm.name AS sender_name, srm.role AS sender_role
         FROM messages m LEFT JOIN sales_reps srm ON srm.id = m.rep_id
        WHERE m.id = :id`,
      { replacements: { id: message.id } }
    );
    const io = req.app.get("io");
    if (io && row) {
      io.to("admins").emit("newMessage", row);
      if (lead.assigned_to && lead.assigned_to !== adminRepId) {
        io.to(`rep_${lead.assigned_to}`).emit("newMessage", row);
      }
    }

    res.json({
      success: true,
      channel,
      channel_label: REPLY_CHANNEL_LABEL[channel],
      pushed,
      message: row || message,
      note: "Fizza stays quiet on this chat for 24 hours because a person replied. Click \"Give to Fizza\" to hand it back sooner.",
    });
  } catch (err) {
    console.error("[fizza-chats] admin reply error:", err);
    res.status(500).json({ error: "Failed to send reply" });
  }
});

router.post("/send", async (req, res) => {
  try {
    const { phone, message, whatsapp_account_id } = req.body || {};
    if (!phone || !message) {
      return res.status(400).json({ error: "phone and message are required" });
    }

    // Normalize phone
    let cleanPhone = String(phone).replace(/[^0-9+]/g, "");
    if (!cleanPhone.startsWith("+")) cleanPhone = "+" + cleanPhone;

    // Find or create the lead
    let [[lead]] = await sequelize.query(
      "SELECT * FROM leads WHERE phone = :phone AND merged_into_lead_id IS NULL LIMIT 1",
      { replacements: { phone: cleanPhone } }
    );

    if (!lead) {
      // Try without + prefix
      const noPlus = cleanPhone.replace(/^\+/, "");
      [[lead]] = await sequelize.query(
        "SELECT * FROM leads WHERE (phone = :p1 OR phone = :p2) AND merged_into_lead_id IS NULL LIMIT 1",
        { replacements: { p1: cleanPhone, p2: noPlus } }
      );
    }

    if (!lead) {
      // One door in. This insert left out whatsapp_account_id, which is NOT
      // NULL on leads with no default, and it set no owner. The front desk
      // always supplies an account and an owner, and it matches on the last
      // 10 digits so "+92300..." and "0300..." don't become two contacts.
      const frontDesk = require("../services/frontDesk");
      const { contact } = await frontDesk.findOrCreateContact({
        channel:    "phone",
        phone:      cleanPhone.replace(/^\+/, ""),
        stage:      "lead",
        loosePhone: true,
        source:     "whatsapp",
        gate:       "fizza_chat",
      });
      [[lead]] = await sequelize.query(
        "SELECT * FROM leads WHERE id = :id",
        { replacements: { id: contact.id } }
      );
    }

    // Find the WhatsApp account to send from
    let accId = whatsapp_account_id;
    if (!accId) {
      // Use the lead's account, or fall back to first active account
      accId = lead.whatsapp_account_id;
      if (!accId) {
        const [[acc]] = await sequelize.query(
          "SELECT id FROM whatsapp_accounts WHERE status = 'active' LIMIT 1"
        );
        accId = acc?.id;
      }
    }
    if (!accId) {
      return res.status(400).json({ error: "No active WhatsApp account found" });
    }

    // Send via baileys socket
    const { getBaileysClient } = require("../whatsapp/baileysClient");
    const sock = getBaileysClient(accId);
    if (!sock) {
      return res.status(400).json({ error: "WhatsApp account not connected", detail: "Account #" + accId + " is not online" });
    }
    const jid = cleanPhone.replace("+", "") + "@s.whatsapp.net";
    await sock.sendMessage(jid, { text: message.trim() });

    // Without these, her inbound reply won't match this lead and the handler
    // would create a duplicate.
    if (!lead.whatsapp_account_id || !lead.whatsapp_jid) {
      try {
        await sequelize.query(
          `UPDATE leads
              SET whatsapp_account_id = COALESCE(whatsapp_account_id, :acc),
                  whatsapp_jid        = COALESCE(whatsapp_jid, :jid)
            WHERE id = :id`,
          { replacements: { acc: accId, jid, id: lead.id } }
        );
      } catch (e) {
        console.warn("[fizza-chats] whatsapp id backfill failed:", e.message);
      }
    }

    // Save the outbound message
    // ('admin' was never a valid sender, so this insert used to fail AFTER
    // the WhatsApp had gone out.) One door: saved as the admin, a person.
    await require("../services/frontDesk").saveMessage({
      contact: lead, direction: "OUT", channel: "whatsapp", from: "rep", text: message.trim(),
      accountId: accId, repId: req.user.repId,
    });

    // Update lead activity
    await sequelize.query(
      "UPDATE leads SET last_message_at = NOW(), last_activity_at = NOW() WHERE id = :id",
      { replacements: { id: lead.id } }
    );

    // Hand this lead over to Fizza — when they reply, Fizza auto-handles it.
    // Ignored if the column isn't added yet (run script/addFizzaHandled.js).
    try {
      await sequelize.query(
        "UPDATE leads SET fizza_handled = 1 WHERE id = :id",
        { replacements: { id: lead.id } }
      );
    } catch (e) {
      console.warn("[fizza-chats] fizza_handled not set:", e.message);
    }

    // Emit to CRM sockets
    try {
      const io = req.app.get("io");
      if (io) {
        io.to("admins").emit("messageSent", { lead_id: lead.id });
      }
    } catch (_) {}

    res.json({
      success: true,
      lead_id: lead.id,
      lead_name: lead.name,
      lead_phone: lead.phone,
      message: message.trim(),
    });
  } catch (err) {
    console.error("[fizza-chats] send error:", err);
    res.status(500).json({ error: "Failed to send message", detail: err.message });
  }
});

/* ───────────────────────────────────────────────
   DELETE /api/admin/fizza-chats/:leadId
   Clear this lead's conversation: removes its messages and AI replies.
   The LEAD ITSELF IS KEPT — only the chat history is removed.
─────────────────────────────────────────────── */
router.delete("/:leadId", async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const leadId = parseInt(req.params.leadId);
    if (!leadId) {
      await t.rollback();
      return res.status(400).json({ error: "Invalid lead ID" });
    }

    const [[lead]] = await sequelize.query(
      "SELECT id FROM leads WHERE id = :leadId",
      { replacements: { leadId }, transaction: t }
    );
    if (!lead) {
      await t.rollback();
      return res.status(404).json({ error: "Lead not found" });
    }

    // ai_corrections cascade off ai_replies; messages carry no FK from ai_replies.
    await sequelize.query("DELETE FROM ai_replies WHERE lead_id = :leadId",
      { replacements: { leadId }, transaction: t });
    await sequelize.query("DELETE FROM messages WHERE lead_id = :leadId",
      { replacements: { leadId }, transaction: t });

    await t.commit();

    // Best-effort tidy-up; never fail the delete over it.
    try {
      await sequelize.query("UPDATE leads SET unread_count = 0 WHERE id = :leadId",
        { replacements: { leadId } });
    } catch (_) {}

    res.json({ success: true, lead_id: leadId });
  } catch (err) {
    try { await t.rollback(); } catch (_) {}
    console.error("[fizza-chats] delete error:", err.message);
    res.status(500).json({ error: "Failed to delete chat", detail: err.message });
  }
});

/* ───────────────────────────────────────────────
   POST /api/admin/fizza-chats/:leadId/takeover   { who: "rep" | "fiza" | null }
   Admin takes one chat off Fizza, or hands it back.

   "rep"  → Fizza stops replying to this woman; her rep answers.
   "fiza" → Fizza answers her, even if the default says a rep should.
   null   → clear the override and go back to the campaign / channel default.

   One field, one decision. services/replyOwner.js reads it before every reply,
   so nothing else has to be told.
─────────────────────────────────────────────── */
router.post("/:leadId/takeover", async (req, res) => {
  try {
    const leadId = parseInt(req.params.leadId, 10);
    if (!leadId) return res.status(400).json({ error: "Invalid lead ID" });

    let { who } = req.body || {};
    if (who === "" || who === undefined) who = null;
    if (who !== null && who !== "fiza" && who !== "rep") {
      return res.status(400).json({ error: 'who must be "rep", "fiza" or null' });
    }

    const [[lead]] = await sequelize.query(
      "SELECT id, name, phone FROM leads WHERE id = :id AND merged_into_lead_id IS NULL",
      { replacements: { id: leadId } }
    );
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const replyOwner = require("../services/replyOwner");
    await replyOwner.setForChat(leadId, who, req.user?.repId || null);

    // Say what will actually happen next, resolved the same way a real reply
    // would be, so the UI never claims something the resolver disagrees with.
    const now = await replyOwner.whoReplies({ id: leadId }, { channel: "whatsapp" });

    res.json({
      success: true,
      lead_id: leadId,
      override: who,
      replying_now: now.who,
      why: now.why,
    });
  } catch (err) {
    console.error("[fizza-chats] takeover error:", err);
    res.status(err.status === 503 ? 503 : 500).json({ error: err.message });
  }
});

/* ───────────────────────────────────────────────
   POST /api/admin/fizza-chats/campaign/:campaignId/replier  { who }
   Same control, one scope out: who answers replies to a whole campaign.
─────────────────────────────────────────────── */
router.post("/campaign/:campaignId/replier", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.campaignId, 10);
    if (!campaignId) return res.status(400).json({ error: "Invalid campaign ID" });

    let { who } = req.body || {};
    if (who === "" || who === undefined) who = null;
    if (who !== null && who !== "fiza" && who !== "rep") {
      return res.status(400).json({ error: 'who must be "rep", "fiza" or null' });
    }

    const [[campaign]] = await sequelize.query(
      "SELECT campaign_id, name FROM campaigns WHERE campaign_id = :id",
      { replacements: { id: campaignId } }
    );
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    try {
      await sequelize.query(
        "UPDATE campaigns SET replying_now = :who WHERE campaign_id = :id",
        { replacements: { id: campaignId, who } }
      );
    } catch (e) {
      if (/replying_now/i.test(String(e.message || ""))) {
        return res.status(503).json({ error: "Run migration 039 first (campaigns.replying_now)" });
      }
      throw e;
    }

    require("../services/replyOwner").clearCache();
    res.json({ success: true, campaign_id: campaignId, name: campaign.name, replying_now: who });
  } catch (err) {
    console.error("[fizza-chats] campaign replier error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────────────────────────────────────
   POST /api/admin/fizza-chats/default-replier  { channel, who }
   The outermost scope: who answers a channel by default.
   channel: "whatsapp" (covers IG/FB too) or "app".
─────────────────────────────────────────────── */
router.post("/default-replier", async (req, res) => {
  try {
    const { channel, who } = req.body || {};
    if (!["fiza", "rep"].includes(who)) {
      return res.status(400).json({ error: 'who must be "fiza" or "rep"' });
    }
    const key = channel === "app" ? "default_replier_app" : "default_replier";
    await sequelize.query(
      `INSERT INTO layer_system_settings (setting_key, setting_value, updated_by)
       VALUES (:k, :v, :by)
       ON DUPLICATE KEY UPDATE setting_value = :v, updated_by = :by`,
      { replacements: { k: key, v: who, by: req.user?.repId || null } }
    );
    require("../services/replyOwner").clearCache();
    res.json({ success: true, setting: key, who });
  } catch (err) {
    console.error("[fizza-chats] default replier error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
