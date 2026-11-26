const { Message } = require("../../models");
const { onlineUsers, repInBackground } = require("../../socket/repState");
const { sendPushToSalesRep } = require("../services/notificationService");
const { writeActivity } = require("../services/activity.service");
const { fireEvent } = require("../services/event.service");

async function handleIncomingWhatsAppMessage({
  whatsapp_jid,
  alt_jid = null,     // her other WhatsApp id (number ↔ @lid), when known
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
  // Everything that used to live here — lookup by JID, the @lid re-point, the
  // round-robin, the create, the duplicate-insert race — is now shared with
  // every other door in services/frontDesk.js. Two behaviours changed as a
  // result: a rep messaging a brand-new number from their own phone creates
  // her (it used to save nothing at all), and the same woman written with a
  // different phone format is recognised instead of duplicated.
  const frontDesk = require("../services/frontDesk");

  let person = null;
  let isNewPerson = false;
  try {
    const seen = await frontDesk.findOrCreateContact({
      channel:   "whatsapp",
      identity:  whatsapp_jid,
      altIdentity: alt_jid,
      accountId: whatsappAccountId,
      phone,
      source:    "whatsapp",
      // Two different relationships: she wrote to us, or a rep reached out
      // from the shared phone. They used to be indistinguishable.
      gate:      fromMe ? "whatsapp_rep_phone" : "whatsapp_inbound",
    });
    person      = seen.contact;
    isNewPerson = seen.isNew;
  } catch (e) {
    console.error(`❌ [frontDesk] could not record ${whatsapp_jid}:`, e.message);
    return;
  }
  const repInitiated = isNewPerson && fromMe;

  if (!person) return;

  /* =========================
     SAVE MESSAGE
  ========================= */
  // The front desk writes it down, bumps her unread count on inbound, and
  // moves the silence clock so the follow-up engine won't message on top.
  const { message } = await frontDesk.saveMessage({
    contact:   person,
    direction: fromMe ? "OUT" : "IN",
    channel:   "whatsapp",
    from:      fromMe ? "rep" : "user",
    text,
    accountId: whatsappAccountId,
    externalMessageId: whatsappMessageId,
    repId:     fromMe ? person.assigned_to : null,
    messageType: message_type,
    mediaUrl:  media_url,
    mediaMime: media_mime,
    mediaSize: media_size,
    duration,
    fileName:  file_name,
  });

  // A photo she sent while a payment request is open → check it as her slip
  // (services/paymentRequest.service.js). Async; never blocks this message.
  if (!fromMe && message && media_url && (message_type === "image" || message_type === "document")) {
    try { require("../services/paymentRequest.service").onInbound(person, message.toJSON ? message.toJSON() : message, io); }
    catch (e) { console.warn("[payment] hook:", e.message); }
  }

  if (fromMe && repInitiated) {
    // No activity row: nothing was received. But she is a new contact, so the
    // automation engine still needs to know she exists.
    await fireEvent(person.id, "lead_created", { source: "whatsapp", phone, direction: "outbound" });
    console.log(`📤 Lead ${person.id} created from a rep's own outbound message to ${whatsapp_jid}`);
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

    // Phase 5 — Campaign reply tracking + opt-out detection.
    // Any reply counts (voice notes and photos too), and a message WhatsApp
    // already marked delivered / read still counts: before Nov 2026 only
    // 'sent' rows were matched, so most replies were never recorded.
    if (!fromMe) {
      try {
        const sequelize = require("../config/database");
        const [rows] = await sequelize.query(
          `SELECT id, campaign_id FROM campaign_recipients
            WHERE lead_id = :leadId AND status IN ('sent','delivered','read')
              AND replied_at IS NULL AND sent_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
          { replacements: { leadId: person.id } }
        );
        if (rows.length) {
          await sequelize.query(
            "UPDATE campaign_recipients SET status = 'replied', replied_at = NOW(), next_step_at = NULL WHERE id IN (:ids)",
            { replacements: { ids: rows.map((r) => r.id) } }
          );
          for (const cid of [...new Set(rows.map((r) => r.campaign_id))]) {
            await sequelize.query(
              "UPDATE campaigns SET replied_count = replied_count + :n WHERE campaign_id = :cid",
              { replacements: { n: rows.filter((r) => r.campaign_id === cid).length, cid } }
            ).catch(() => {});
          }
        }
      } catch (err) {
        console.error("❌ [campaign reply hook] failed:", err.message);
      }
    }
    if (message_type === "text" && text) {
      try {
        // 2. Opt-out detection — adds to dnc_list if STOP/UNSUBSCRIBE/etc.
        const { checkAndRecordOptOut } = require("../broadcast/optOutDetector");
        const optOut = await checkAndRecordOptOut(person, text);
        if (optOut && optOut.optedOut) justOptedOut = true;
        // The "is this a Fizza auto-reply campaign?" lookup used to run here on
        // every inbound message. services/replyOwner.js asks the same question
        // only when there is actually a reply to send, so it's gone from here.
      } catch (err) {
        console.error("❌ [campaign reply hook] failed:", err.message);
      }
    }
  }

  /* =========================
     EMIT SOCKET
  ========================= */
  const repId = person.assigned_to;
  const newMessagePayload = {
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
  };
  io.to(`rep_${repId}`).emit("newMessage", newMessagePayload);
  // Admin views (e.g. Fizza Chats) listen on the admins room so open chats
  // update live instead of needing a manual refresh.
  io.to("admins").emit("newMessage", newMessagePayload);

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
  let voiceConfidence = 0;
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
          voiceConfidence = Number(transcript.confidence) || 0;
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
    const threshold = parseFloat(process.env.AI_CONFIDENCE_THRESHOLD || "0.65");
    // Phase 17 — voice-sourced messages are Tier 2 (rep approves, never auto-send)
    // unless VOICE_AUTO_REPLY_ENABLED=true AND the transcript is confident enough.
    // Mishearing a voice note about a medical condition is the risk this guards.
    const voiceAutoOk =
      process.env.VOICE_AUTO_REPLY_ENABLED === "true" &&
      voiceConfidence >= parseFloat(process.env.VOICE_MIN_CONFIDENCE || "0.6");
    const forceTier2 = voiceWasTranscribed && !voiceAutoOk;
    if (voiceWasTranscribed) {
      console.log(`🎙️  [VoiceTx] Lead ${person.id} conf=${voiceConfidence.toFixed(2)} → ${voiceAutoOk ? "AUTO-SEND allowed" : "draft for rep (Tier 2)"}`);
    }

    // Push this inbound into the batcher. The callback fires after the debounce
    // window has elapsed with the COMBINED text from all rapid inbounds.
    batcherPush(person.id, { text, msg_id: message.id }, async (combinedText, msgIds, meta = {}) => {
      // Reload person — Layer 1 may have updated state during the batch wait
      try { await person.reload(); } catch {}
      // Use the LAST inbound message_id as the anchor for AI reply
      const latestMessageId = msgIds[msgIds.length - 1] || message.id;
      const isCurrent = typeof meta.isCurrent === "function" ? meta.isCurrent : () => true;

      // "typing…" on her phone while Fiza writes — only when Fiza is the one
      // who'll answer, so a rep's chat never shows a typing that goes nowhere.
      const typing = require("../channels/whatsappChannel");
      let typingOn = false;
      try {
        const pre = await require("../services/replyOwner").whoReplies(person, { channel: "whatsapp" });
        if (pre.who === "fiza" && !forceTier2) typingOn = await typing.setTyping(person, true);
      } catch (_) { /* cosmetic only */ }
      const stopTyping = () => { if (typingOn) { typingOn = false; typing.setTyping(person, false).catch(() => {}); } };

      // Phase 17b — pass voice context so Fiza keeps sales persona on voice replies
      return generateReply(person, combinedText, latestMessageId, { sourceWasVoice: voiceWasTranscribed })
      .then(async ({ replyId, reply, escalate, confidence, error }) => {
        // She sent more while Fiza was writing (or a rep took over): this reply
        // is out of date. A fresh one covering everything is already on its way.
        if (!isCurrent()) {
          console.log(`⏭️  [Fiza] lead ${person.id} — reply ${String(replyId).slice(0, 8)} superseded by a newer message, not sent`);
          if (replyId) {
            require("../config/database").query(
              "UPDATE ai_replies SET status = 'rejected', error_message = 'superseded by a newer message' WHERE reply_id = ?",
              { replacements: [replyId] }
            ).catch(() => {});
          }
          return; // the newer reply keeps the typing indicator going
        }
        stopTyping();
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
        // WHO REPLIES TO HER — one question, one function.
        //
        // This used to be six things read in one condition: AI_COPILOT_MODE,
        // a per-lead fizza_handled flag, a per-campaign fizza_auto_reply, the
        // silent-escalation list, the confidence threshold and the automation
        // pause. services/replyOwner.js now holds the order, and an admin can
        // take over one chat or a whole campaign without an env change.
        const replyOwner = require("../services/replyOwner");
        const decision = await replyOwner.whoReplies(person, {
          channel: "whatsapp",
          escalate,
        });

        // A soft escalation (ready_to_pay, human_requested) must NOT silence
        // her — she just said she wants to buy. replyOwner only hands those to
        // a rep when the tag is in AI_SILENT_ESCALATIONS.
        if (escalate && decision.who === "fiza") {
          console.log(`🔔 [Fiza] lead ${person.id} escalate=${escalate} — replying anyway, rep still notified`);
        }

        // Three things still veto a send regardless of who "should" reply:
        // the master pause, a voice note we aren't confident enough about, and
        // Fizza being unsure of her own answer.
        // Confidence = how well her knowledge matched the message. A greeting
        // or "ok / ji / thanks" matches nothing specific, so it scores low even
        // though it's the easiest thing to answer: small talk is always fine.
        const confidentEnough = confidence >= threshold || isSmallTalk(combinedText);
        const shouldAutoSend =
          decision.who === "fiza" && !automationPaused && !forceTier2 && confidentEnough;

        console.log(
          `🧭 [replyOwner] lead ${person.id} → ${decision.who} (${decision.why})` +
          (shouldAutoSend ? " — Fizza sending" : ` — draft for rep${automationPaused ? ", automation paused" : ""}${!confidentEnough ? `, confidence ${confidence.toFixed(2)} < ${threshold}` : ""}`)
        );

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
          // She sent a voice note -> answer with a voice note instead of text,
          // when VOICE_REPLY_ENABLED allows it for this number. Falls back to
          // text if TTS or the send fails.
          let voiceSent = false;
          if (voiceWasTranscribed) {
            try {
              const voice = require("../ai/voiceReply.service");
              const voiceDraft = {
                leadId: person.id,
                phone: person.phone,
                message_id: latestMessageId,
                whatsapp_jid: person.whatsapp_jid,
                whatsapp_account_id: person.whatsapp_account_id,
                assigned_to: person.assigned_to,
              };
              if (await voice.shouldVoiceReply(voiceDraft)) {
                const vr = await voice.sendVoiceReply(voiceDraft, reply, io);
                voiceSent = !!(vr && vr.sent);
                if (voiceSent) {
                  const sequelizeVR = require("../config/database");
                  await sequelizeVR.query(
                    "UPDATE ai_replies SET status='sent', sent_at=NOW() WHERE reply_id = ?",
                    { replacements: [replyId] }
                  );
                  // Keep the follow-up engine from double-messaging her.
                  await sequelizeVR.query(
                    "UPDATE leads SET last_message_at = NOW(), last_activity_at = NOW() WHERE id = ?",
                    { replacements: [person.id] }
                  );
                  io.to(`rep_${repId}`).emit("aiAutoSent", {
                    reply_id: replyId, lead_id: person.id, message: reply
                  });
                  io.to("admins").emit("aiAutoSent", {
                    reply_id: replyId, lead_id: person.id, message: reply
                  });
                  console.log(`🎙️  [Fiza] replied to lead ${person.id} with a VOICE note`);
                } else {
                  console.warn(`[Fiza] voice reply failed (${vr && vr.error}) — sending text instead`);
                }
              }
            } catch (e) {
              console.error("[Fiza] voice reply error — sending text instead:", e.message);
            }
          }

          const { send: sendWA } = require("../channels/whatsappChannel");
          const result = voiceSent
            ? { success: false, skippedForVoice: true }
            : await sendWA(person, reply);
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
                // Fizza sent this, not a human rep — keeps the chat history and
                // the admin UI honest (shows as 🤖 Fizza instead of 👤 Rep).
                from: "ai",
                io,
              });
            } catch (e) {
              console.error("[Fiza] recordOutbound failed:", e.message);
            }
            io.to(`rep_${repId}`).emit("aiAutoSent", {
              reply_id: replyId, lead_id: person.id, message: reply
            });
            io.to("admins").emit("aiAutoSent", {
              reply_id: replyId, lead_id: person.id, message: reply
            });
            // Phase 15c — fire voice/poster after Fiza's text lands
            try {
              const { maybeFireEngagementAsset } = require("../services/firstTouch.service");
              await person.reload();
              maybeFireEngagementAsset(person, io).catch(() => {});
            } catch {}
          } else if (!result.skippedForVoice) {
            // (A voice note that already went out — and was saved by
            // voiceReply.service — is not a failure: no draft for the rep,
            // or she would get the same answer twice.)
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


// Short greeting / acknowledgement (≤4 words, a greeting or ack word, no
// question mark or numbers) — e.g. "Hello mam", "AoA", "ji ok", "thanks".
const SMALL_TALK_WORDS = new Set(("hi hii hiii hello helo hey salam slam assalam assalamualaikum assalamoalaikum aoa asalam " +
  "walaikum wa alaikum alaikum aslam o ok okay okk oky k ji jee jii g han haan hnji acha achha theek thik thek " +
  "thanks thank thankyou thx shukriya shukria jazakallah good nice great sure yes yup no nahi done " +
  "mam maam madam mem sis sister aapi api baji dear").split(/\s+/));
function isSmallTalk(text) {
  const t = String(text || "").toLowerCase().replace(/[^a-z\s?0-9]/g, " ").trim();
  if (!t || t.length > 40 || /[?0-9]/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  const known = words.filter((w) => SMALL_TALK_WORDS.has(w)).length;
  return known >= 1 && known >= words.length - 1; // at most one unknown word (a typo like "nam")
}

module.exports = { handleIncomingWhatsAppMessage };
