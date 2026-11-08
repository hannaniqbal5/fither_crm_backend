const { saveMessage } = require("./message.service");
const { People, Message } = require("../../models");
const { onlineUsers, repInBackground } = require("../../socket/repState");
const { sendPushToSalesRep } = require("../services/notificationService");
const { writeActivity } = require("../services/activity.service");
const { fireEvent } = require("../services/event.service");
const { getNextRepRoundRobin } = require("../services/assignment.service");

async function handleIncomingWhatsAppMessage({
  whatsapp_jid,
  phone,
  text = null,
  whatsappMessageId,
  whatsappAccountId,
  io,
  fromMe,

  // MEDIA FIELDS
  message_type = "text",
  media_url = null,
  media_mime = null,
  media_size = null,
  duration = null,
  file_name = null,
  media_failed = false, // media download failed — saved as a text note, skip AI
}) {
  /* =========================
     SAFETY CHECK
  ========================= */
  if (typeof fromMe !== "boolean") {
    throw new Error("fromMe is required in handleIncomingWhatsAppMessage");
  }

  /* =========================
     DUPLICATE PROTECTION
  ========================= */
  if (whatsappMessageId) {
    const existing = await Message.findOne({
      where: { whatsapp_message_id: whatsappMessageId },
    });
    if (existing) return;
  }

  /* =========================
     FIND OR CREATE PERSON
  ========================= */
  let person = await People.findOne({ where: { whatsapp_jid } });

  // JID changed (e.g. WhatsApp switched this contact to a @lid JID, or back):
  // the lead's unique key is (phone, whatsapp_account_id), so find it by phone
  // and re-point its whatsapp_jid instead of losing / duplicating the message.
  if (!person && phone && whatsappAccountId) {
    person = await People.findOne({ where: { phone, whatsapp_account_id: whatsappAccountId } });
    if (person) {
      const oldJid = person.whatsapp_jid;
      try {
        await person.update({ whatsapp_jid });
        console.log(`🔁 Lead ${person.id} JID switched: ${oldJid} → ${whatsapp_jid}`);
      } catch (e) {
        console.warn(`⚠️ Lead ${person.id} JID switch ${oldJid} → ${whatsapp_jid} not saved: ${e.message}`);
      }
    }
  }
  let isNewPerson = !person && !fromMe;

  if (!person && !fromMe) {
    // Round-robin assignment is handled by the shared service, which:
    //   • creates the AssignmentState pointer row if it doesn't exist yet
    //     (no more crash on a fresh DB), and
    //   • returns null when there are zero active reps
    //     (no more modulo-by-zero crash).
    // Scope the round-robin to the account that received this message so
    // the lead only goes to a rep on that same WhatsApp number.
    const nextRep = await getNextRepRoundRobin(whatsappAccountId);
    if (!nextRep) {
      console.warn(
        `⚠️ No active sales rep on account ${whatsappAccountId} to assign new lead ${whatsapp_jid} — creating unassigned`
      );
    }

    try {
      person = await People.create({
        phone,
        whatsapp_jid,
        stage: "visitor",
        status: "new",
        assigned_to: nextRep ? nextRep.id : null,
        whatsapp_account_id: whatsappAccountId,
        last_message_at: new Date(),
        last_activity_at: new Date(),
        source: "whatsapp",
      });
    } catch (e) {
      // Two messages from a brand-new contact processed at once: the other one
      // created the lead first. Re-fetch it instead of dropping this message.
      if (e && e.name === "SequelizeUniqueConstraintError") {
        person =
          (await People.findOne({ where: { whatsapp_jid } })) ||
          (phone ? await People.findOne({ where: { phone, whatsapp_account_id: whatsappAccountId } }) : null);
        if (!person) throw e;
        isNewPerson = false; // the creator fires lead_created
        await person.update({ last_message_at: new Date() });
      } else {
        throw e;
      }
    }
  } else if (person) {
    // Update last_message_at + fill phone if we resolved it from LID
    const updateFields = { last_message_at: new Date() };
    if (phone && !person.phone) {
      updateFields.phone = phone;
      console.log(`📞 Phone auto-filled for person ${person.id}: ${phone}`);
    }
    await person.update(updateFields);
  }

  if (!person) return;

  /* =========================
     SAVE MESSAGE
  ========================= */
  const { message } = await saveMessage({
    phone,
    whatsapp_jid,
    whatsappAccountId,
    from: fromMe ? "rep" : "user",
    message: text,
    direction: fromMe ? "OUT" : "IN",
    status: fromMe ? "sent" : "received",
    whatsappMessageId,
    repId: fromMe ? person.assigned_to : null,
    is_read: false,
    message_type,
    media_url,
    media_mime,
    media_size,
    duration,
    file_name,
  });

  if (!fromMe) {
    await People.increment({ unread_count: 1 }, { where: { id: person.id } });
  }

  /* =========================
     WRITE ACTIVITY + FIRE EVENT
     (only for inbound messages — outbound are rep actions)
  ========================= */
  let justOptedOut = false;
  if (!fromMe) {
    // Write activity row + update lead_score + last_activity_at
    await writeActivity(person.id, "message_received", "whatsapp", {
      message_type,
      whatsapp_message_id: whatsappMessageId,
    });

    // Fire lead_created event on the very first message
    if (isNewPerson) {
      await fireEvent(person.id, "lead_created", { source: "whatsapp", phone });
    }

    // Phase 5 — Campaign reply tracking + opt-out detection
    if (message_type === "text" && text) {
      try {
        // 1. Mark any in-flight campaign_recipients as 'replied'
        const sequelize = require("../config/database");
        await sequelize.query(
          `UPDATE campaign_recipients
              SET status = 'replied', replied_at = NOW()
            WHERE lead_id = :leadId AND status = 'sent'`,
          { replacements: { leadId: person.id } }
        );
        await sequelize.query(
          `UPDATE campaigns c
             JOIN campaign_recipients cr ON cr.campaign_id = c.campaign_id
              SET c.replied_count = c.replied_count + 1
            WHERE cr.lead_id = :leadId AND cr.replied_at = NOW()`,
          { replacements: { leadId: person.id } }
        ).catch(() => {});

        // 2. Opt-out detection — adds to dnc_list if STOP/UNSUBSCRIBE/etc.
        const { checkAndRecordOptOut } = require("../broadcast/optOutDetector");
        const optOut = await checkAndRecordOptOut(person, text);
        if (optOut && optOut.optedOut) justOptedOut = true;
      } catch (err) {
        console.error("❌ [campaign reply hook] failed:", err.message);
      }
    }
  }

  /* =========================
     EMIT SOCKET
  ========================= */
  const repId = person.assigned_to;
  io.to(`rep_${repId}`).emit("newMessage", {
    id: message.id,
    lead_id: person.id,
    message: message.message,
    message_type: message.message_type,
    media_url: message.media_url,
    media_mime: message.media_mime,
    media_size: message.media_size,
    duration: message.duration,
    file_name: message.file_name,
    direction: message.direction,
    status: message.status,
    whatsapp_message_id: message.whatsapp_message_id,
    createdAt: message.created_at,
  });

  /* =========================
     PUSH WHEN REP IS NOT IN FOREGROUND
  ========================= */
  if (!fromMe && repId) {
    const isRepOnline = !!onlineUsers[repId];

    if (isRepOnline) {
      console.log(`📡 [Rep ${repId}] FOREGROUND (socket) → Push SKIPPED`);
    } else {
      const reason = repInBackground.has(repId) ? "tab in background" : "socket disconnected";
      console.log(`📤 [Rep ${repId}] Not in foreground (${reason}) → sending push via FIREBASE`);

      const title = "New message";
      const preview =
        message_type === "text" && text
          ? String(text).length > 80 ? String(text).slice(0, 80) + "…" : text
          : message_type === "audio" || message_type === "voice"
          ? "Voice message 🎤"
          : message_type === "image"
          ? "Photo 📷"
          : "New message";

      sendPushToSalesRep(repId, title, `Lead #${person.id}: ${preview}`, {
        lead_id: person.id,
        message_id: message.id,
        lead_phone: person.phone || "",
        lead_name: person.name || "",
      })
        .then((result) => {
          if (result?.success) {
            console.log(`✅ [Rep ${repId}] FIREBASE push SENT (${result.sent} token(s)) [${reason}]`);
          } else {
            console.log(`⚠️ [Rep ${repId}] Push skipped: ${result?.reason || "unknown"}`);
          }
        })
        .catch((err) => {
          console.error(`❌ [Rep ${repId}] Push FAILED:`, err.message || err);
        });
    }
  }

  /* =========================
     VOICE TRANSCRIPTION — Phase 17
     If the inbound is a voice/audio note, transcribe it with Gemini
     and use the transcript as the "text" for the rest of the pipeline.
     Adds 2-4 sec of latency, but no other code change downstream.
  ========================= */
  let voiceWasTranscribed = false;
  if (
    !fromMe &&
    (message_type === "audio" || message_type === "voice") &&
    media_url &&
    person.stage !== "user" &&
    process.env.VOICE_TRANSCRIBE_ENABLED !== "false"
  ) {
    try {
      const { transcribeFromPath, persistTranscript, resolveMediaPath } = require("../ai/voiceTranscription.service");
      const localPath = resolveMediaPath(media_url);
      if (localPath) {
        const transcript = await transcribeFromPath(localPath, {
          leadId: person.id,
          messageId: message.id,
          mimeType: media_mime,
        });
        if (transcript && transcript.text) {
          await persistTranscript(message.id, transcript);
          text = transcript.text;             // re-bind for downstream Layer 1 / Fiza
          voiceWasTranscribed = true;
          console.log(`🎙️  [VoiceTx] Lead ${person.id} voice → text pipeline (lang=${transcript.language}, conf=${transcript.confidence.toFixed(2)})`);
        } else {
          console.log(`🎙️  [VoiceTx] Lead ${person.id} voice transcription returned empty — leaving as raw audio for rep`);
        }
      } else {
        console.warn(`[VoiceTx] Could not resolve media_url to local path: ${media_url}`);
      }
    } catch (e) {
      console.error("⚠️  [VoiceTx] suppressed:", e.message);
    }
  }

  /* =========================
     LAYER SYSTEM — Layer 1 intent detection (Phase 8)
     Runs synchronously on every inbound text message OR transcribed voice.
     Updates: interaction_status, main_goal, last_objection, funnel_stage,
              lead_score, intent_history.
     NEVER throws — intentApplier swallows its own errors.
  ========================= */
  if (!fromMe && !media_failed && ((message_type === "text" && text) || voiceWasTranscribed) && person.stage !== "user") {
    try {
      const { applyIntent } = require("../ai/intentApplier");
      await applyIntent(person, text, io);
      // Reload person so AI hook below has the freshest intent context
      await person.reload();
    } catch (e) {
      console.error("⚠️  [Layer1] intent apply failed (suppressed):", e.message);
    }

    // ── Layer 2 — Gemini classifier (fire-and-forget) ──
    if (process.env.LAYER2_ENABLED !== "false") {
      const { classify } = require("../ai/layer2Classifier");
      classify(person, text)
        .then(out => {
          if (out && io && person.assigned_to) {
            io.to(`rep_${person.assigned_to}`).emit("intentUpdated", {
              lead_id: person.id, source: "layer2", confidence: out.confidence,
            });
          }
        })
        .catch(err => console.error("⚠️  [Layer2] hook error (suppressed):", err.message));
    }
  }

  /* =========================
     AI AGENT HOOK (Phase 3 — Fiza)
     Fire-and-forget. NEVER awaited — AI failures must not block message processing.
     Phase 15b: routes inbound through MessageBatcher so rapid messages get
                combined into one AI reply instead of three.
     Triggers only when:
       - master flag AI_AGENT_ENABLED=true
       - inbound message (fromMe=false)
       - text content (we don't ask the AI to interpret media yet)
       - person is not already a paying customer (stage !== "user")
  ========================= */
  if (
    process.env.AI_AGENT_ENABLED === "true" &&
    !fromMe &&
    !media_failed &&     // media lost — the rep handles it, Fiza can't see it
    !justOptedOut &&     // this message was an opt-out — no AI sales reply
    ((message_type === "text" && text) || voiceWasTranscribed) &&
    person.stage !== "user"
  ) {
    // Lazy-require so the SDK isn't loaded if the feature is off
    const { generateReply } = require("../ai/reply.service");
    const { push: batcherPush } = require("../services/messageBatcher.service");
    const isCopilot = process.env.AI_COPILOT_MODE !== "false";  // default: copilot ON
    const threshold = parseFloat(process.env.AI_CONFIDENCE_THRESHOLD || "0.65");
    // Phase 17 — voice-sourced messages are ALWAYS Tier 2 (rep approves, never auto-send)
    const forceTier2 = voiceWasTranscribed;

    // Push this inbound into the batcher. The callback fires after the debounce
    // window has elapsed with the COMBINED text from all rapid inbounds.
    batcherPush(person.id, { text, msg_id: message.id }, async (combinedText, msgIds) => {
      // Reload person — Layer 1 may have updated state during the batch wait
      try { await person.reload(); } catch {}
      // Use the LAST inbound message_id as the anchor for AI reply
      const latestMessageId = msgIds[msgIds.length - 1] || message.id;
      // Phase 17b — pass voice context so Fiza keeps sales persona on voice replies
      return generateReply(person, combinedText, latestMessageId, { sourceWasVoice: voiceWasTranscribed })
      .then(async ({ replyId, reply, escalate, confidence, error }) => {
        if (error || !reply) {
          // generation already logged failure — surface to rep dashboard
          io.to(`rep_${repId}`).emit("aiDraftFailed", { reply_id: replyId, lead_id: person.id, error });
          return;
        }

        // Mental health escalation = page rep urgently and DO NOT auto-send
        if (escalate === "mental_health") {
          io.to(`rep_${repId}`).emit("aiUrgentEscalation", {
            reply_id: replyId, lead_id: person.id, draft: reply, reason: escalate
          });
          sendPushToSalesRep(
            repId,
            "🚨 URGENT — possible mental-health flag",
            `Lead #${person.id} needs you now`,
            { lead_id: person.id, ai_reply_id: replyId, urgent: "1" }
          ).catch(e => console.error("urgent push failed:", e.message));
          // Persist a tracked escalation row so it's not just a fleeting socket
          // ping (gives the previously-orphaned Escalation model a real writer).
          try {
            if (person.assigned_to) {
              const { Escalation } = require("../../models");
              await Escalation.create({
                lead_id:     person.id,
                raised_by:   person.assigned_to, // AI raised it on the assigned rep's behalf
                assigned_to: person.assigned_to,
                issue_type:  `ai_${escalate}`,   // e.g. ai_mental_health
                description: reply ? String(reply).slice(0, 1000) : null,
                status:      "open",
              });
            }
          } catch (e) {
            console.error("[Escalation] create failed:", e.message);
          }
          return;
        }

        // Master kill-switch: when automation is paused, never auto-send — surface
        // as a draft for the rep instead.
        let automationPaused = false;
        try {
          const { isAutomationPaused } = require("../services/sendGate");
          automationPaused = await isAutomationPaused();
        } catch {}
        const shouldAutoSend = !automationPaused && !isCopilot && !escalate && !forceTier2 && confidence >= threshold;

        // Phase 17 — mark this draft as voice-sourced so the UI can highlight it
        if (forceTier2 && replyId) {
          try {
            const sequelize = require("../config/database");
            await sequelize.query(
              "UPDATE ai_replies SET source_was_voice = 1 WHERE reply_id = ?",
              { replacements: [replyId] }
            );
          } catch (e) {
            console.error("[VoiceTx] failed to mark source_was_voice:", e.message);
          }
        }

        if (shouldAutoSend) {
          const { send: sendWA } = require("../channels/whatsappChannel");
          const result = await sendWA(person, reply);
          if (result.success) {
            const sequelize = require("../config/database");
            await sequelize.query(
              "UPDATE ai_replies SET status='sent', sent_at=NOW() WHERE reply_id = ?",
              { replacements: [replyId] }
            );
            // Persist the auto-sent message + bump last_message_at so it shows
            // in chat history AND the follow-up engine sees the lead was just
            // contacted (prevents Fiza + follow-up double-messaging).
            try {
              const { recordOutbound } = require("../services/outboundMessage");
              await recordOutbound(person, {
                text: reply,
                channel: "whatsapp",
                externalId: result.messageId,
                repId: person.assigned_to,
                io,
              });
            } catch (e) {
              console.error("[Fiza] recordOutbound failed:", e.message);
            }
            io.to(`rep_${repId}`).emit("aiAutoSent", {
              reply_id: replyId, lead_id: person.id, message: reply
            });
            // Phase 15c — fire voice/poster after Fiza's text lands
            try {
              const { maybeFireEngagementAsset } = require("../services/firstTouch.service");
              await person.reload();
              maybeFireEngagementAsset(person, io).catch(() => {});
            } catch {}
          } else {
            console.error(`❌ [AI] auto-send failed for reply ${replyId}: ${result.error}`);
            io.to(`rep_${repId}`).emit("aiDraftReady", {
              reply_id: replyId, lead_id: person.id, draft: reply, confidence, escalate
            });
          }
        } else {
          // Co-pilot mode (or low confidence / regular escalation / voice-sourced) — surface as draft
          io.to(`rep_${repId}`).emit("aiDraftReady", {
            reply_id: replyId, lead_id: person.id, draft: reply, confidence, escalate,
            source_was_voice: forceTier2,
          });
        }
      })
      .catch(err => console.error("❌ [AI] hook failure (suppressed):", err.message));
    });
  }
}

module.exports = { handleIncomingWhatsAppMessage };
