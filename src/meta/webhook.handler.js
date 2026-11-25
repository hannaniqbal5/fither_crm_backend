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

const sequelize = require("../config/database");
const { People, Message } = require("../../models");
const { writeActivity } = require("../services/activity.service");
const { fireEvent } = require("../services/event.service");
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
 * NOTE: upsertLeadFromMeta() and saveMetaMessage() used to live here.
 * They were this door's own private copy of "find or create her" and
 * "write the message down", and they had drifted from the WhatsApp copy:
 * no opt-out check, no intent detection, attachments discarded, and the
 * lead stamped to WhatsApp account 1 while round-robin was called with no
 * account at all (so an Instagram lead could land on a rep who sits on a
 * different number and never see her).
 *
 * Both are now services/frontDesk.js, shared with every other door.
 */

/**
 * Process a single inbound DM event.
 */
async function handleMessagingEvent(channel, page, evt, io) {
  // Skip our own outbound (echoes from sending)
  if (evt.message?.is_echo) return;

  const senderPsid = evt.sender?.id;
  const messageId  = evt.message?.mid;
  let   text       = evt.message?.text;

  if (!senderPsid || !messageId) return;
  // Attachment-only DMs used to be thrown away here, so a woman who sent a
  // photo or a voice note simply did not exist. Save a note instead, the same
  // way the WhatsApp door handles a media download it cannot complete: the rep
  // sees that she wrote in, and Fiza is told to stay out of it.
  let messageType = "text";
  const attachments = Array.isArray(evt.message?.attachments) ? evt.message.attachments : [];
  if (!text) {
    if (!attachments.length) return;
    const kinds = attachments.map((a) => a && a.type).filter(Boolean);
    messageType = "text";
    text = `[${kinds.join(", ") || "attachment"} received on ${channel} — open the thread to view]`;
    console.log(`📥 [Meta/${channel}] attachment-only DM from ${senderPsid} (${kinds.join(", ")}) — saved as a note`);
  }

  // Fetch user profile (name) — best effort, don't fail message processing if it errors
  let profile = {};
  try {
    profile = await getUserProfile(page.page_access_token, senderPsid);
  } catch (err) {
    console.warn(`⚠️  [Meta] getUserProfile failed for ${senderPsid}: ${err.message}`);
  }

  // ── THE FRONT DESK ──
  // Finds or creates her, assigns an owner on the same account she is stamped
  // to, dedupes against Meta's redeliveries, writes the message down and moves
  // the silence clock. One call, the same five checks every other door gets.
  const frontDesk = require("../services/frontDesk");
  const { contact: lead, message, isNew, duplicate } = await frontDesk.receive({
    channel,
    identity:          senderPsid,
    name:              profile.username || profile.name || null,
    metaPageId:        page.id,
    source:            channel,
    gate:              `${channel}_dm`,
    text,
    messageType,
    externalMessageId: messageId,
    externalThreadId:  senderPsid,
  });

  if (duplicate) {
    console.log(`↪️  [Meta/${channel}] Duplicate message ${messageId} — ignored`);
    return;
  }

  // Activity + event
  await writeActivity(lead.id, "message_received", channel, { external_message_id: messageId });
  if (isNew) {
    await fireEvent(lead.id, "lead_created", { source: channel, psid: senderPsid });
  }

  // Opt-out detection. The WhatsApp door has always done this; this one never
  // did, so a woman who typed STOP on Instagram kept being sold to.
  let justOptedOut = false;
  try {
    const { checkAndRecordOptOut } = require("../broadcast/optOutDetector");
    const optOut = await checkAndRecordOptOut(lead, text);
    if (optOut && optOut.optedOut) justOptedOut = true;
  } catch (err) {
    console.error(`⚠️  [Meta/${channel}] opt-out check failed:`, err.message);
  }

  // Layer 1 intent, so an Instagram lead moves through the funnel like a
  // WhatsApp one instead of sitting at "visitor" forever.
  if (!justOptedOut && lead.stage !== "user") {
    try {
      const { applyIntent } = require("../ai/intentApplier");
      await applyIntent(lead, text, io);
      if (typeof lead.reload === "function") await lead.reload();
    } catch (err) {
      console.error(`⚠️  [Meta/${channel}] intent apply failed (suppressed):`, err.message);
    }
  }

  // Emit socket so the rep dashboard updates in real time. Admin views (Fizza
  // Chats) listen on the admins room, same as the WhatsApp door.
  if (io) {
    const payload = {
      id: message.id,
      lead_id: lead.id,
      message: text,
      channel,
      direction: "IN",
      message_type: messageType,
      external_message_id: messageId,
      created_at: new Date().toISOString(),
    };
    if (lead.assigned_to) io.to(`rep_${lead.assigned_to}`).emit("newMessage", payload);
    io.to("admins").emit("newMessage", payload);
  }

  // Fire AI agent (Fiza) — fire-and-forget, same pattern as WhatsApp handler
  if (
    process.env.AI_AGENT_ENABLED === "true" &&
    !justOptedOut &&
    lead.stage !== "user"
  ) {
    const { generateReply } = require("../ai/reply.service");
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
        // WHO REPLIES — the same decision the WhatsApp door uses
        // (services/replyOwner.js), so a rep's Fiza level, a campaign's
        // "who handles replies" setting, an admin takeover and the locked
        // guardrails (health / complaint / payment / "talk to a human") apply
        // on Instagram and Facebook too. This replaces the old global
        // AI_COPILOT_MODE switch, which ignored all of them.
        const replyOwner = require("../services/replyOwner");
        const decision = await replyOwner.whoReplies(lead, { channel, escalate });
        const shouldAutoSend =
          decision.who === "fiza" && !automationPaused && confidence >= threshold;
        console.log(
          `🧭 [replyOwner/${channel}] lead ${lead.id} → ${decision.who} (${decision.why})` +
          (shouldAutoSend ? " — Fizza sending" : ` — draft for rep${automationPaused ? ", automation paused" : ""}${confidence < threshold ? `, confidence ${Number(confidence).toFixed(2)} < ${threshold}` : ""}`)
        );

        if (shouldAutoSend) {
          // Send via the matching channel adapter
          const channelRouter = require("../channels/channelRouter");
          const result = await channelRouter.send(lead, reply, channel);
          if (result.success) {
            await sequelize.query(
              "UPDATE ai_replies SET status='sent', sent_at=NOW() WHERE reply_id = ?",
              { replacements: [replyId] }
            );
            // One door out. This reply used to go to Instagram and never be
            // written down, so it was missing from the thread the rep sees and
            // the silence clock never moved — the follow-up engine could then
            // message her on top of Fiza.
            try {
              await frontDesk.saveMessage({
                contact:   lead,
                direction: "OUT",
                channel,
                from:      "bot",
                text:      reply,
                externalMessageId: result.messageId || null,
                externalThreadId:  lead.instagram_psid || lead.facebook_psid || null,
              });
            } catch (e) {
              console.error(`[Meta/${channel}] saving Fiza's reply failed:`, e.message);
            }
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
      const frontDesk = require("../services/frontDesk");

      // She is a contact the moment we decide to message her, not when she
      // happens to answer. Before this, a woman who commented and got auto-DMed
      // existed only as a row in `comments`: no contact, no record of what we
      // sent her, and no way for a rep to pick the conversation up.
      //
      // Caveat worth knowing: the id on a comment and the id Meta uses for
      // messaging are not guaranteed to be the same value. If she later DMs us
      // and arrives under a different id, she'll show up as a second contact
      // for the merge queue to join, which is still far better than vanishing.
      const { contact } = await frontDesk.findOrCreateContact({
        channel:    channel,
        identity:   fromUser.id,
        name:       fromUser.username || fromUser.name || null,
        metaPageId: page.id,
        source:     channel,
        gate:       `${channel}_comment`,
      });

      // Never cold-DM a woman who has already asked us to stop.
      if (await frontDesk.isSilenced(contact)) {
        console.log(`[Meta/${channel}] contact ${contact.id} opted out — comment ${commentId} left alone`);
        await sequelize.query(
          // comments.status is ENUM('new','public_replied','dm_sent','converted','ignored')
          `UPDATE comments SET status = 'ignored' WHERE comment_id = :id`,
          { replacements: { id: commentId } }
        ).catch(() => {});
        return;
      }

      // 1. Public reply (short, brand-safe)
      const publicReply = "Sent you a DM 🌸";
      await replyToComment(page.page_access_token, commentId, publicReply);

      // 2. Private DM (kicks off the AI sales flow)
      const privateMsg = "Hi aapi! Saw your comment — happy to help. Aap ka main goal kya hai (PCOS, weight loss, postpartum, fitness)?";
      const dm = await privateReplyToComment(page.page_access_token, commentId, privateMsg);

      // 3. Put the DM on her timeline, so the rep sees what she was already told.
      try {
        await frontDesk.saveMessage({
          contact,
          direction: "OUT",
          channel,
          from:      "bot",
          text:      privateMsg,
          externalMessageId: (dm && (dm.message_id || dm.id)) || null,
          externalThreadId:  fromUser.id,
        });
      } catch (e) {
        console.error(`[Meta/${channel}] saving the comment DM failed:`, e.message);
      }

      await sequelize.query(
        `UPDATE comments
            SET status = 'dm_sent', ai_handled = 1, lead_id = :leadId
          WHERE comment_id = :id`,
        { replacements: { id: commentId, leadId: contact.id } }
      );

      console.log(`✅ [Meta/${channel}] Comment ${commentId} converted to DM for contact ${contact.id}`);
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
