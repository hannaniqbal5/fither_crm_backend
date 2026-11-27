/**
 * reply.service.js — main entry point for generating an AI reply.
 *
 * Pipeline:
 *   1. Retrieve top-K knowledge chunks
 *   2. Pull last 8 messages for conversation context
 *   3. Build system prompt with both
 *   4. Call Gemini LLM
 *   5. Parse for <ESCALATE/> tags
 *   6. Persist as ai_replies row with status='draft'
 *   7. Return { replyId, reply, escalate, confidence, chunks }
 *
 * NEVER throws upward — caller (message.handler) treats this as fire-and-forget.
 */

const { v4: uuidv4 } = require("uuid");
const { generateText } = require("./gemini.client");
const { retrieve } = require("./retrieval.service");
const { buildSystemPrompt } = require("./prompt.builder");
const { pickMode } = require("./modeRouter");
const sequelize = require("../config/database");
const { Message } = require("../../models");

const ESCALATE_REGEX = /<ESCALATE\s+reason="([^"]+)"\s*\/>/i;
// English + Roman Urdu + Urdu ways of asking for a refund / money back.
const REFUND_REGEX = /\b(refunds?|refunded|refundable|money\s*back|paise?\s*wap(a|i)s|paisay?\s*wap(a|i)s|pais[ae]\s*wapis|raqam\s*wap(a|i)s|wap(a|i)s\s*(kar|kr|chahiye|chahye|de))|ریفنڈ|پیسے\s*واپس/i;

/** Did we (Fiza or a rep) message her in the last 12h? Then it's mid-conversation. */
async function isMidConversation(personId) {
  try {
    const last = await Message.findOne({
      where: { lead_id: personId, direction: "OUT" },
      order: [["created_at", "DESC"]],
      attributes: ["created_at"],
    });
    if (last && Date.now() - new Date(last.created_at).getTime() < 12 * 60 * 60 * 1000) return true;
    // Copilot mode: Fiza's earlier draft may still be waiting for the rep — still the same chat.
    const [rows] = await sequelize.query(
      "SELECT 1 FROM ai_replies WHERE lead_id = ? AND status <> 'failed' AND created_at > (NOW() - INTERVAL 12 HOUR) LIMIT 1",
      { replacements: [personId] }
    );
    return rows.length > 0;
  } catch (_) { return false; }
}

/** Strip the formatting tells that make a WhatsApp text look machine-written. */
function humanize(text, midConversation) {
  let t = String(text || "");
  t = t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)\*(\S.*?\S)\*(?=\s|$)/g, "$1$2"); // bold / italics
  t = t.replace(/^#{1,6}\s+/gm, "");                         // headings
  t = t.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",");  // long dashes → comma
  t = t.replace(/!{2,}/g, "!");
  if (midConversation) {
    // Drop a leading "Hello ma'am," / "Hi ma'am!" — nobody re-greets mid-chat.
    t = t.replace(/^(\[TEST\]\s*)?(hello|hi|hey)\s+(ma['’]?am|mam)\s*[,!.]?\s*/i, "$1");
    t = t.replace(/^(\[TEST\]\s*)?([a-z])/, (m, pre, c) => (pre || "") + c.toUpperCase());
  }
  return t.replace(/[ \t]{2,}/g, " ").trim();
}

async function getRecentConversation(personId, limit = 8) {
  const recent = await Message.findAll({
    where: { lead_id: personId },
    order: [["created_at", "DESC"]],
    limit,
  });

  return recent
    .reverse()
    .map(m => {
      const speaker = m.direction === "IN" ? "User" : "Fiza/Rep";
      const body = m.message ? m.message.replace(/\s+/g, " ").trim() : `[${m.message_type}]`;
      return `${speaker}: ${body}`;
    })
    .join("\n");
}

async function persistDraft({ replyId, personId, messageId, userMessage, aiResponse, chunks, confidence, escalateReason, status, errorMessage }) {
  const chunksPayload = (chunks || []).map(c => ({
    chunk_id:    c.chunk_id,
    source_file: c.source_file,
    score:       Number((c.score || 0).toFixed(4)),
  }));

  await sequelize.query(
    `INSERT INTO ai_replies
       (reply_id, lead_id, message_id, user_message, ai_response,
        retrieved_chunks, confidence, escalate_reason, status, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        replyId,
        personId,
        messageId || null,
        userMessage || null,
        aiResponse || "",
        JSON.stringify(chunksPayload),
        confidence != null ? Number(confidence.toFixed(4)) : null,
        escalateReason || null,
        status || "draft",
        errorMessage || null,
      ],
    }
  );
}

/**
 * generateReply — produce an AI draft for a given person + their latest message.
 *
 * @param {object} person                 — People model instance
 * @param {string} latestMessageText      — what the user just sent
 * @param {number} [latestMessageId]      — id of the inbound Message row
 * @returns {Promise<{ replyId, reply, escalate, confidence, chunks }>}
 */
async function generateReply(person, latestMessageText, latestMessageId, opts = {}) {
  const sourceWasVoice = !!opts.sourceWasVoice;
  // Every reply knows where she is (plan, trial, classes, the campaign she
  // answered). Callers with their own context (auto-takeover, app chat) pass
  // it; WhatsApp and Instagram/Facebook replies get it built here.
  // opts.journeyContext === false turns it off.
  let journeyContext = opts.journeyContext || null;
  if (!journeyContext && opts.journeyContext !== false && person && person.id) {
    try {
      journeyContext = await require("./journeyContext").buildJourneyContext(person.id);
    } catch (e) {
      console.warn(`[AI] journey context skipped for lead ${person.id}: ${e.message}`);
    }
  }
  const t0 = Date.now();
  const replyId = uuidv4();

  try {
    // Decide which mode handles this message — sales / winback / support
    const { mode, reason: modeReason } = pickMode(person, latestMessageText);
    console.log(`🎯 [AI] Mode = ${mode} — ${modeReason}`);

    // Retrieve KB chunks filtered by mode's allowed categories
    // These four don't depend on each other — fetch them at the same time
    // (the KB search is a network call; the rest are DB reads).
    // Phase 11 — admin-promoted few-shot examples that match this lead's context
    const fewShotP = (async () => {
      try {
        const { getExamples } = require("./aiFeedback.service");
        return await getExamples({
          interaction_status: person.interaction_status,
          main_goal: person.main_goal,
          last_objection: person.last_objection,
        }, 3);
      } catch (e) {
        console.error("⚠️  [AI] few-shot fetch failed:", e.message);
        return [];
      }
    })();
    const [chunks, history, midConversation, fewShotExamples] = await Promise.all([
      retrieve(latestMessageText, { mode }),
      getRecentConversation(person.id),
      isMidConversation(person.id),
      fewShotP,
    ]);

    // Phase 14b — when she's clearly ready to pay, inject her country's payment accounts
    let paymentAccounts = [];
    const paymentSignal =
      ["ready_to_pay","payment_link_sent","payment_pending"].includes(person.interaction_status) ||
      (Number(person.lead_score) || 0) >= 60 ||
      /pay|account|bhejna|kahan|kaha|kaise paid|account details/i.test(latestMessageText || "");
    if (paymentSignal && person.phone) {
      try {
        const { detectCountry } = require("../services/phoneCountry");
        const countryCode = detectCountry(person.phone) || "PK";
        const [rows] = await sequelize.query(
          `SELECT account_type, bank_name, account_holder, account_number, iban, instructions
             FROM payment_accounts
             WHERE country_code = ? AND is_active = 1
             ORDER BY display_order ASC, id ASC
             LIMIT 3`,
          { replacements: [countryCode] }
        );
        paymentAccounts = rows || [];
      } catch (e) {
        console.warn("⚠️  [AI] payment-account fetch failed:", e.message);
      }
    }

    const systemPrompt = buildSystemPrompt(chunks, history, mode, fewShotExamples, paymentAccounts, {
      sourceWasVoice,
      journeyContext,
      midConversation,
      intentContext: {
        interaction_status: person.interaction_status,
        main_goal:          person.main_goal,
        last_objection:     person.last_objection,
        lead_score:         person.lead_score,
        name:               person.name,
      },
    });

    const rawReply = await generateText(latestMessageText, systemPrompt, {
      operation: "reply",
      reply_id: replyId,
      lead_id: person.id,
    });

    const escalateMatch = ESCALATE_REGEX.exec(rawReply);
    const cleanReply = humanize(rawReply.replace(ESCALATE_REGEX, "").trim(), midConversation);

    const confidence = chunks[0] && typeof chunks[0].score === "number" ? chunks[0].score : 0;
    // Refunds always go to a person (rep), even if the model forgot the tag:
    // "complaint" is a locked hand-off in services/replyOwner.js.
    const escalateReason = escalateMatch
      ? escalateMatch[1]
      : (REFUND_REGEX.test(String(latestMessageText || "")) ? "complaint" : null);

    // Nothing left after stripping the escalate tag → save as failed, not as an
    // empty draft (an escalation keeps going so the rep is still paged).
    if (!cleanReply && !escalateReason) {
      throw new Error("AI reply was empty");
    }

    await persistDraft({
      replyId,
      personId: person.id,
      messageId: latestMessageId,
      userMessage: latestMessageText,
      aiResponse: cleanReply,
      chunks,
      confidence,
      escalateReason,
      status: escalateReason === "mental_health" ? "escalated" : "draft",
    });


    console.log(
      `🤖 [AI] Draft ${replyId.slice(0, 8)} for person ${person.id} ` +
      `(${mode} mode) in ${Date.now() - t0}ms — confidence ${confidence.toFixed(2)}` +
      (escalateReason ? ` — escalate: ${escalateReason}` : "")
    );

    return { replyId, reply: cleanReply, escalate: escalateReason, confidence, chunks, mode };

  } catch (err) {
    console.error(`❌ [AI] Reply generation failed for person ${person.id}:`, err.message);

    try {
      await persistDraft({
        replyId,
        personId: person.id,
        messageId: latestMessageId,
        userMessage: latestMessageText,
        aiResponse: "",
        chunks: [],
        confidence: 0,
        escalateReason: "unknown",
        status: "failed",
        errorMessage: err.message,
      });
    } catch (persistErr) {
      console.error("❌ [AI] Even failure persistence failed:", persistErr.message);
    }
    return { replyId, reply: null, escalate: "unknown", confidence: 0, chunks: [], error: err.message };
  }
}

module.exports = { generateReply, humanize };
