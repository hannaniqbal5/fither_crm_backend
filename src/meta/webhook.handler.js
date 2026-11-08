/**
 * webhook.handler.js — parses inbound events from Meta and routes them.
 *
 * Meta sends events as a single POST with a top-level `entry[]` array. Each entry
 * can contain multiple `messaging` (DMs) or `changes` (comments, mentions) events.
 *
 * Handler responsibilities:
 *   1. Verify HMAC-SHA256 signature (`x-hub-signature-256` header)
 *   2. For each event, find the matching meta_pages row → get page access token
 *   3. Route by type:
 *      - DM        → upsert lead, save message, fire AI agent (same as WA flow)
 *      - Comment   → save to comments table, fire comment-to-DM auto-conversion
 *      - Postback  → log only (button clicks; rare)
 *   4. Always 200 OK to Meta — even on internal errors (Meta retries on non-200)
 */

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const sequelize = require("../config/database");
const { People, Message } = require("../../models");
const { writeActivity } = require("../services/activity.service");
const { fireEvent } = require("../services/event.service");
const { getNextRepRoundRobin } = require("../services/assignment.service");
const { getUserProfile } = require("./graphClient");

/**
 * Verify the request body's HMAC-SHA256 signature against META_APP_SECRET.
 * Meta sends header `X-Hub-Signature-256: sha256=<hex>`.
 */
function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith("sha256=")) return false;

  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    console.error("❌ [Meta] META_APP_SECRET not set — cannot verify webhook");
    return false;
  }

  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");

  const provided = signatureHeader.slice("sha256=".length);

  // timing-safe compare
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(provided, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Look up the meta_pages row for a given page or IG account ID.
 * Caches in-memory for 5 minutes.
 */
const pageCache = new Map();
const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;

async function findPage(idOrIgId) {
  const cached = pageCache.get(idOrIgId);
  if (cached && Date.now() - cached.t < PAGE_CACHE_TTL_MS) return cached.row;

  const [rows] = await sequelize.query(
    `SELECT id, page_id, instagram_account_id, page_access_token, status
       FROM meta_pages
      WHERE page_id = :id OR instagram_account_id = :id
      LIMIT 1`,
    { replacements: { id: idOrIgId } }
  );
  const row = rows[0] || null;
  pageCache.set(idOrIgId, { row, t: Date.now() });
  return row;
}

/**
 * Upsert a lead from a Meta PSID (Instagram or Facebook).
 * If the lead already exists (matched by PSID), updates last_message_at.
 * If new, creates the lead with channel-specific identifier + assigns rep round-robin.
 */
async function upsertLeadFromMeta({ channel, psid, page, profile = {} }) {
  const idColumn = channel === "instagram" ? "instagram_psid" : "facebook_psid";
  const usernameColumn = channel === "instagram" ? "instagram_username" : "facebook_name";

  // 1. Try to find existing lead
  const [existingRows] = await sequelize.query(
    `SELECT * FROM leads WHERE ${idColumn} = :psid LIMIT 1`,
    { replacements: { psid } }
  );

  if (existingRows.length > 0) {
    const lead = existingRows[0];
    await sequelize.query(
      `UPDATE leads SET last_message_at = NOW() WHERE id = :id`,
      { replacements: { id: lead.id } }
    );
    return { lead, isNew: false };
  }

  // 2. Create new lead
  const nextRep = await getNextRepRoundRobin();
  const repId = nextRep ? nextRep.id : null;

  const [insertResult] = await sequelize.query(
    `INSERT INTO leads (
       phone, name, ${idColumn}, ${usernameColumn},
       meta_page_id, source, stage, status, assigned_to,
       whatsapp_account_id, last_message_at, last_activity_at, created_at
     ) VALUES (
       NULL, :name, :psid, :username,
       :metaPageId, :channel, 'visitor', 'new', :repId,
       1, NOW(), NOW(), NOW()
     )`,
    {
      replacements: {
        name: profile.name || null,
        psid,
        username: profile.username || profile.name || null,
        metaPageId: page.id,
        channel,
        repId,
      },
    }
  );

  const newLeadId = insertResult.insertId || insertResult;

  const [createdRows] = await sequelize.query(
    `SELECT * FROM leads WHERE id = :id`,
    { replacements: { id: newLeadId } }
  );

  return { lead: createdRows[0], isNew: true };
}

/**
 * Save a message row for a Meta DM event.
 */
async function saveMetaMessage({ channel, leadId, repId, externalMessageId, externalThreadId, text, fromMe }) {
  // Dedup
  if (externalMessageId) {
    const [existing] = await sequelize.query(
      `SELECT id FROM messages WHERE external_message_id = :mid LIMIT 1`,
      { replacements: { mid: externalMessageId } }
    );
    if (existing.length > 0) return { ...existing[0], duplicate: true };
  }

  const [r] = await sequelize.query(
    `INSERT INTO messages (
       lead_id, rep_id, whatsapp_account_id,
       \`from\`, channel, external_message_id, external_thread_id,
       message, direction, message_type, status, is_read, created_at
     ) VALUES (
       :leadId, :repId, NULL,
       :from, :channel, :mid, :tid,
       :text, :dir, 'text', :status, 0, NOW()
     )`,
    {
      replacements: {
        leadId,
        repId: repId || null,
        from: fromMe ? "rep" : "user",
        channel,
        mid: externalMessageId || null,
        tid: externalThreadId || null,
        text: text || null,
        dir: fromMe ? "OUT" : "IN",
        status: fromMe ? "sent" : "received",
      },
    }
  );

  return { id: r.insertId };
}

/**
 * Process a single inbound DM event.
 */
async function handleMessagingEvent(channel, page, evt, io) {
  // Skip our own outbound (echoes from sending)
  if (evt.message?.is_echo) return;

  const senderPsid = evt.sender?.id;
  const messageId  = evt.message?.mid;
  const text       = evt.message?.text;

  if (!senderPsid || !messageId) return;
  if (!text) {
    // Attachment-only messages — skip text path (extension point for media handling later)
    console.log(`📥 [Meta/${channel}] Non-text message from ${senderPsid} — skipping for now`);
    return;
  }

  // Fetch user profile (name) — best effort, don't fail message processing if it errors
  let profile = {};
  try {
    profile = await getUserProfile(page.page_access_token, senderPsid);
  } catch (err) {
    console.warn(`⚠️  [Meta] getUserProfile failed for ${senderPsid}: ${err.message}`);
  }

  const { lead, isNew } = await upsertLeadFromMeta({ channel, psid: senderPsid, page, profile });

  // Save inbound message
  const message = await saveMetaMessage({
    channel,
    leadId: lead.id,
    externalMessageId: messageId,
    externalThreadId: senderPsid,
    text,
    fromMe: false,
  });

  // Meta re-delivers webhooks — a message we already stored must not bump
  // unread again or trigger a second AI reply.
  if (message.duplicate) {
    console.log(`↪️  [Meta/${channel}] Duplicate message ${messageId} — ignored`);
    return;
  }

  // Increment unread for rep
  await sequelize.query(
    `UPDATE leads SET unread_count = unread_count + 1 WHERE id = :id`,
    { replacements: { id: lead.id } }
  );

  // Activity + event
  await writeActivity(lead.id, "message_received", channel, { external_message_id: messageId });
  if (isNew) {
    await fireEvent(lead.id, "lead_created", { source: channel, psid: senderPsid });
  }

  // Emit socket so rep dashboard updates in real time
  if (lead.assigned_to && io) {
    io.to(`rep_${lead.assigned_to}`).emit("newMessage", {
      id: message.id,
      lead_id: lead.id,
      message: text,
      channel,
      direction: "IN",
      external_message_id: messageId,
      created_at: new Date().toISOString(),
    });
  }

  // Fire AI agent (Fiza) — fire-and-forget, same pattern as WhatsApp handler
  if (
    process.env.AI_AGENT_ENABLED === "true" &&
    lead.stage !== "user"
  ) {
    const { generateReply } = require("../ai/reply.service");
    const isCopilot = process.env.AI_COPILOT_MODE !== "false";
    const threshold = parseFloat(process.env.AI_CONFIDENCE_THRESHOLD || "0.65");

    generateReply(lead, text, message.id)
      .then(async ({ replyId, reply, escalate, confidence, error }) => {
        if (error || !reply) {
          if (lead.assigned_to && io) {
            io.to(`rep_${lead.assigned_to}`).emit("aiDraftFailed", {
              reply_id: replyId, lead_id: lead.id, error,
            });
          }
          return;
        }

        if (escalate === "mental_health") {
          if (lead.assigned_to && io) {
            io.to(`rep_${lead.assigned_to}`).emit("aiUrgentEscalation", {
              reply_id: replyId, lead_id: lead.id, draft: reply, reason: escalate,
            });
          }
          return;
        }

        // Master kill-switch (same as the WhatsApp path): when automation is
        // paused, never auto-send — surface as a draft for the rep instead.
        let automationPaused = false;
        try {
          const { isAutomationPaused } = require("../services/sendGate");
          automationPaused = await isAutomationPaused();
        } catch {}
        const shouldAutoSend = !automationPaused && !isCopilot && !escalate && confidence >= threshold;

        if (shouldAutoSend) {
          // Send via the matching channel adapter
          const channelRouter = require("../channels/channelRouter");
          const result = await channelRouter.send(lead, reply, channel);
          if (result.success) {
            await sequelize.query(
              "UPDATE ai_replies SET status='sent', sent_at=NOW() WHERE reply_id = ?",
              { replacements: [replyId] }
            );
            if (lead.assigned_to && io) {
              io.to(`rep_${lead.assigned_to}`).emit("aiAutoSent", {
                reply_id: replyId, lead_id: lead.id, message: reply,
              });
            }
          } else if (lead.assigned_to && io) {
            io.to(`rep_${lead.assigned_to}`).emit("aiDraftReady", {
              reply_id: replyId, lead_id: lead.id, draft: reply, confidence, escalate,
            });
          }
        } else if (lead.assigned_to && io) {
          io.to(`rep_${lead.assigned_to}`).emit("aiDraftReady", {
            reply_id: replyId, lead_id: lead.id, draft: reply, confidence, escalate,
          });
        }
      })
      .catch(err => console.error(`❌ [Meta/${channel}] AI hook failure:`, err.message));
  }
}

/**
 * Process a single comment event (Instagram or Facebook).
 * - Saves to comments table
 * - Triggers comment-to-DM auto-conversion if AI is enabled
 */
async function handleCommentEvent(channel, page, change, io) {
  const value = change.value || {};
  const commentId = value.comment_id || value.id;
  const postId    = value.post_id || value.media?.id || value.parent_id;
  const text      = value.message || value.text;
  const fromUser  = value.from || {};

  if (!commentId || !postId) return;

  // Don't act on our own comments / our page replying to itself
  if (fromUser.id === page.page_id || fromUser.id === page.instagram_account_id) return;

  // Save comment
  await sequelize.query(
    `INSERT IGNORE INTO comments (
       comment_id, channel, post_id, parent_comment_id, meta_page_id,
       external_user_id, external_username, message, status, created_at
     ) VALUES (
       :commentId, :channel, :postId, :parentId, :metaPageId,
       :userId, :username, :message, 'new', NOW()
     )`,
    {
      replacements: {
        commentId,
        channel,
        postId,
        parentId: value.parent_id || null,
        metaPageId: page.id,
        userId: fromUser.id || null,
        username: fromUser.username || fromUser.name || null,
        message: text || null,
      },
    }
  );

  console.log(`💬 [Meta/${channel}] Comment ${commentId} on post ${postId}: "${text?.slice(0, 60) || ""}"`);

  // Comment-to-DM auto-conversion (best-effort)
  // Only if AI is enabled AND we have message content to act on
  if (
    process.env.AI_AGENT_ENABLED === "true" &&
    text && text.trim().length > 0 &&
    fromUser.id
  ) {
    try {
      const { isAutomationPaused } = require("../services/sendGate");
      if (await isAutomationPaused()) {
        console.log(`[Meta/${channel}] automation paused — comment ${commentId} left for the rep`);
        return;
      }
      const { replyToComment, privateReplyToComment } = require("./graphClient");

      // 1. Public reply (short, brand-safe)
      const publicReply = "Sent you a DM 🌸";
      await replyToComment(page.page_access_token, commentId, publicReply);

      // 2. Private DM (kicks off the AI sales flow)
      const privateMsg = "Hi aapi! Saw your comment — happy to help. Aap ka main goal kya hai (PCOS, weight loss, postpartum, fitness)?";
      await privateReplyToComment(page.page_access_token, commentId, privateMsg);

      await sequelize.query(
        `UPDATE comments
            SET status = 'dm_sent', ai_handled = 1
          WHERE comment_id = :id`,
        { replacements: { id: commentId } }
      );

      console.log(`✅ [Meta/${channel}] Comment ${commentId} converted to DM`);
    } catch (err) {
      console.error(`❌ [Meta/${channel}] Comment-to-DM failed for ${commentId}:`, err.message);
    }
  }
}

/**
 * Top-level handler — called from the Express route after signature verification.
 *
 * Meta payload shape:
 * {
 *   "object": "page" | "instagram",
 *   "entry": [
 *     { "id": "<page_or_ig_id>",
 *       "messaging": [...],     // for DMs
 *       "changes":  [...] }     // for comments / mentions
 *   ]
 * }
 */
async function handleWebhook(payload, io) {
  if (!payload || !Array.isArray(payload.entry)) return;

  const channel = payload.object === "instagram" ? "instagram" : "facebook";

  for (const entry of payload.entry) {
    const page = await findPage(entry.id);
    if (!page) {
      console.warn(`⚠️  [Meta] Webhook for unknown page/IG account ${entry.id} — ignoring`);
      continue;
    }
    if (page.status !== "active") {
      console.warn(`⚠️  [Meta] Page ${entry.id} is ${page.status} — ignoring`);
      continue;
    }

    // Mark heartbeat
    await sequelize.query(
      `UPDATE meta_pages SET last_webhook_at = NOW() WHERE id = :id`,
      { replacements: { id: page.id } }
    ).catch(() => {});

    // DM events
    if (Array.isArray(entry.messaging)) {
      for (const evt of entry.messaging) {
        try {
          await handleMessagingEvent(channel, page, evt, io);
        } catch (err) {
          console.error(`❌ [Meta/${channel}] messaging event failed:`, err.message);
        }
      }
    }

    // Comment / mention events
    if (Array.isArray(entry.changes)) {
      for (const change of entry.changes) {
        try {
          if (change.field === "comments") {
            await handleCommentEvent(channel, page, change, io);
          }
          // Future: mentions, reactions, story_insights, etc.
        } catch (err) {
          console.error(`❌ [Meta/${channel}] change event failed:`, err.message);
        }
      }
    }
  }
}

module.exports = {
  verifySignature,
  handleWebhook,
};
