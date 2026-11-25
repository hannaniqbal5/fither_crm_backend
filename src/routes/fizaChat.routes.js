/**
 * fizaChat.routes.js — Fiza in the Fit Her app / web (Nov 2026).
 *
 * One chat per woman, channel 'app'. Called by partner_backend (signed, same
 * scheme as the read API — webhookVerifier.verifyAppRead), never by the
 * browser directly:
 *   GET  /api/app/fiza/history?app_user_id=     her chat (last 80 messages)
 *   POST /api/app/fiza/message                  { app_user_id, message, name?, email?, phone?, handoff? }
 *
 * Who answers: services/replyOwner.js decides, the same as on WhatsApp,
 * Instagram and Facebook (channel "app"):
 *   - She asks for a person ("talk to a coach", the button)        → handoff.
 *   - An admin clicked "Take over"  → Fiza stays quiet; her rep gets a task.
 *   - An admin clicked "Give to Fizza" → Fiza answers, even mid-conversation.
 *   - A rep replied to her in the last 24 h (any channel) → Fiza stays quiet.
 *   - A campaign set to Assist → Fiza stays quiet; her rep gets a task.
 *   - Otherwise the app default (Fiza).
 *   - She asks for a person ("talk to a coach", the button)        → handoff.
 *   - Otherwise Fiza answers (ai/reply.service — same brain as WhatsApp).
 *     If Fiza flags it (health, mental health, can't help) or fails → handoff.
 *   Handoff = owner rule task "chat_handoff" (rep gets it in Tasks, due 15 min)
 *   + a message telling her a coach will reply here.
 * The rep sees the whole chat in the CRM and replies there; the reply goes
 * back to her app (leads.controller sendMessage → app channel + push).
 */
const express = require("express");
const sequelize = require("../config/database");
const { verifyAppRead } = require("../app_integration/webhookVerifier");

const router = express.Router();
router.use(verifyAppRead);

const HANDOFF_RE = /\b(talk|speak|chat)\s+(to|with)\s+(a\s+)?(human|person|coach|someone|real)|real person|insaan|coach se baat|kisi se baat|call me|mujhe call/i;

const asChat = (m) => ({
  id: m.id,
  from: m.direction === "IN" ? "me" : m.from === "rep" ? "coach" : "fiza",
  text: m.message,
  image: m.media_url || null,
  at: m.created_at,
});

async function leadFor(appUserId) {
  const [rows] = await sequelize.query(
    "SELECT * FROM leads WHERE app_user_id = :a AND merged_into_lead_id IS NULL LIMIT 1",
    { replacements: { a: String(appUserId) } }
  );
  return rows[0] || null;
}

// One door (services/frontDesk.js): valid sender, silence clock, and her
// unread count for IN.
async function addMessage(lead, { from, direction, text }) {
  const { message: saved } = await require("../services/frontDesk").saveMessage({
    contact: lead, direction, channel: "app", from, text,
    accountId: lead.whatsapp_account_id || 1,
  });
  const id = saved.id;
  const [rows] = await sequelize.query("SELECT * FROM messages WHERE id = :id", { replacements: { id } });
  return rows[0];
}

function pushToReps(req, lead, msg) {
  try {
    const io = req.app.get("io");
    if (!io) return;
    if (lead.assigned_to) io.to(`rep_${lead.assigned_to}`).emit("newMessage", msg);
    io.to("admins").emit("newMessage", msg);
  } catch (_) { /* live update is a nice-to-have */ }
}

async function handOff(lead, why) {
  try {
    const owner = require("../services/owner.service");
    const out = await owner.escalate(lead.id, "chat_handoff", { why: String(why || "").slice(0, 120), canPush: false });
    return out;
  } catch (e) {
    console.error("[fiza-web] handoff failed:", e.message);
    return { action: "error" };
  }
}

// Where she is right now — so Fiza answers for HER situation in the app,
// not a generic WhatsApp script (e.g. "wait for the app link" to a woman
// who is already in the app, or paid onboarding to a woman who hasn't paid).
// Her latest message looks English (no common Roman Urdu words) → reply in English.
const URDU_HINT = /\b(hai|hain|kya|kaise|kab|mein|mujhe|aap|ap|nahi|nhi|kr|kar|karna|chahiye|theek|thik|acha|accha|bata|batao|kitne|kitna|se|ka|ki|ko|ho|raha|rahi)\b/i;
const looksEnglish = (t) => /[a-z]/i.test(t) && !/[\u0600-\u06FF]/.test(t) && !URDU_HINT.test(t);

// Drop a trailing "what's your goal?" if Luna already asked it in this chat.
async function dropRepeatGoal(leadId, reply) {
  const GOAL_Q = /[^.!?\n]*\b(main goal|your goal|goal kya|goal hai)\b[^.!?\n]*\?\s*$/i;
  if (!GOAL_Q.test(reply)) return reply;
  const [rows] = await sequelize.query(
    "SELECT message FROM messages WHERE lead_id = :id AND direction = 'OUT' ORDER BY id DESC LIMIT 12",
    { replacements: { id: leadId } }
  );
  const askedBefore = rows.some((r) => /\b(main goal|your goal|goal kya|goal hai)\b/i.test(r.message || ""));
  if (!askedBefore) return reply;
  const trimmed = reply.replace(GOAL_Q, "").trim();
  return trimmed || reply;
}

async function appJourney(lead, assistant, latestText) {
  const [[l]] = await sequelize.query(
    `SELECT subscription_status, subscription_plan_title, subscription_expires_at, app_onboarded_at,
            main_goal, main_goal_app, stage
       FROM leads WHERE id = :id`, { replacements: { id: lead.id } }
  );
  const [[wa]] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM messages WHERE lead_id = :id AND (channel IS NULL OR channel <> 'app')",
    { replacements: { id: lead.id } }
  );
  const sub = (l && l.subscription_status) || "none";
  const plan =
    sub === "active" ? `She is a PAYING member (${l.subscription_plan_title || "a plan"}). Help her use it: classes, diet, progress.` :
    sub === "trial" ? "She is on a FREE TRIAL. Help her get value (join a class) and, when it fits, suggest a plan in Plans & payment." :
    sub === "frozen" ? "Her plan is FROZEN (paused). Be kind; if she wants to restart, her coach can help." :
    ["expired", "cancelled"].includes(sub) ? "Her plan has ENDED. Welcome her back warmly; plans are in Plans & payment." :
    "She has NOT paid yet. Her next steps in the app: finish her sign-up questions if not done, start the free trial or choose a plan in Plans & payment. Do NOT describe paid-member onboarding (welcome call, community group) as already happening.";
  return [
    assistant === "luna"
      ? "NAME: in the Fit Her mobile app you are called LUNA, the in-app assistant on the Fit Her team (same knowledge as always). If she asks your name, you're Luna."
      : "",
    "CHANNEL: she is writing in the Fit Her APP chat (web or mobile), NOT on WhatsApp. Say 'here' / 'this chat'.",
    "She ALREADY has a Fit Her app account and is inside the app right now: never tell her to download the app, wait for an app link, or watch WhatsApp. Her coach replies in this chat.",
    plan,
    l && !l.app_onboarded_at ? "She has not finished her sign-up questions yet (Profile → About you)." : "",
    (l && (l.main_goal || l.main_goal_app)) ? `Her goal: ${l.main_goal || l.main_goal_app}.` : "",
    Number(wa && wa.n) > 0 ? "Before signing up she talked to us on WhatsApp — the conversation history above includes it; use what she told us there (goal, situation) instead of asking again." : "",
    (l && (l.main_goal || l.main_goal_app))
      ? "You ALREADY KNOW her goal (above): never ask her what her goal is."
      : "",
    sub === "active" || sub === "trial"
      ? "She is already a member: don't pitch FitHer or plans unless she asks. Answer the question and stop."
      : "",
    "DON'T REPEAT: never end every reply with the same question. Ask a question only when you truly need the answer, and never one you already asked earlier in this chat. Many replies need no question at all.",
    "HER NAME: use only her first name, spelled exactly as given (" + (lead.name ? String(lead.name).split(/\s+/)[0].replace(/^\[TEST\]$/i, "") : "unknown") + "), at most once every few messages. Never stretch, repeat letters in, or invent a nickname from it.",
    latestText && looksEnglish(latestText)
      ? "Her latest message is in ENGLISH: reply in English only, no Roman Urdu."
      : "",
    "LANGUAGE: reply in the language she writes in — English if she writes English, Roman Urdu if she writes Roman Urdu. Keep it short (2–4 sentences) and end with one clear next step.",
  ].filter(Boolean).join(" ");
}

router.get("/history", async (req, res) => {
  try {
    const lead = await leadFor(req.query.app_user_id);
    if (!lead) return res.json({ messages: [], coach: null });
    const [rows] = await sequelize.query(
      `SELECT * FROM (SELECT * FROM messages WHERE lead_id = :id AND channel = 'app' ORDER BY id DESC LIMIT 80) t ORDER BY id ASC`,
      { replacements: { id: lead.id } }
    );
    const [[rep]] = await sequelize.query(
      "SELECT name FROM sales_reps WHERE id = :r AND status = 'active'", { replacements: { r: lead.assigned_to || 0 } }
    );
    res.json({ messages: rows.map(asChat), coach: rep ? { name: rep.name } : null });
  } catch (err) {
    console.error("[fiza-web] history:", err);
    res.status(500).json({ error: "server_error", ...(process.env.NODE_ENV !== "production" ? { detail: err.message } : {}) });
  }
});

router.post("/message", async (req, res) => {
  try {
    const b = req.body || {};
    const text = String(b.message || "").trim().slice(0, 2000);
    if (!b.app_user_id) return res.status(400).json({ error: "app_user_id is required" });
    if (!text && !b.handoff) return res.status(400).json({ error: "message is required" });

    const { findOrLinkLead } = require("../app_integration/handlers");
    const { lead } = await findOrLinkLead({ app_user_id: b.app_user_id, phone: b.phone, email: b.email, name: b.name });
    const out = [];

    if (text) {
      const inMsg = await addMessage(lead, { from: "user", direction: "IN", text });
      out.push(inMsg);
      await sequelize.query(
        "UPDATE leads SET last_activity_at = NOW() WHERE id = :id", // unread + last_message_at: frontDesk
        { replacements: { id: lead.id } }
      );
      pushToReps(req, lead, inMsg);
    }

    // WHO ANSWERS — one decision for every channel (services/replyOwner.js).
    const askedForHuman = !!b.handoff || HANDOFF_RE.test(text);
    const decision = await require("../services/replyOwner").whoReplies(lead, { channel: "app", askedForHuman });
    if (decision.who === "rep" && !askedForHuman) {
      // A person has this chat. If nobody is mid-conversation with her (an
      // admin took over, or a campaign is on Assist), make sure her rep gets a
      // task (one open task, not one per message). A rep who replied in the
      // last 24 h already sees her message in the inbox.
      if (text && !/^rep_replied_within_/.test(decision.why)) {
        await handOff(lead, decision.why === "admin_set_on_this_chat" ? "admin set this chat to a person" : `replies go to a person (${decision.why})`);
      }
      return res.json({ status: "with_coach", messages: out.map(asChat) });
    }

    const reply = async (t) => { const m = await addMessage(lead, { from: "bot", direction: "OUT", text: t }); out.push(m); pushToReps(req, lead, m); };

    if (askedForHuman) {
      const h = await handOff(lead, b.handoff ? "tapped 'Talk to a coach'" : text);
      await reply(h.action === "task_created" || h.action === "task_exists"
        ? "Of course 💚 I've asked your coach to reply right here — usually within 15 minutes in working hours. You'll get a notification."
        : "Of course 💚 I've let the Fit Her team know — someone will reply right here soon.");
      return res.json({ status: "handed_off", messages: out.map(asChat) });
    }

    // Fiza answers — same brain as WhatsApp (mode, knowledge base, escalation).
    const { generateReply } = require("../ai/reply.service");
    const r = await generateReply(lead, text, out[0]?.id || null, { journeyContext: await appJourney(lead, b.assistant, text) });
    if (r.reply) {
      r.reply = await dropRepeatGoal(lead.id, r.reply);
      await reply(r.reply);
      await sequelize.query("UPDATE ai_replies SET status = 'sent' WHERE reply_id = :id", { replacements: { id: r.replyId } })
        .catch(() => {}); // auto-sent in the app: not a pending suggestion for the rep
    }
    if (r.escalate || !r.reply) {
      await handOff(lead, r.escalate ? `Fiza flagged: ${r.escalate}` : "Fiza could not answer");
      if (!r.reply) await reply("I want to get this right for you 💚 I've asked your coach to reply here shortly.");
      return res.json({ status: "handed_off", escalate: r.escalate || null, messages: out.map(asChat) });
    }
    res.json({ status: "fiza", messages: out.map(asChat) });
  } catch (err) {
    console.error("[fiza-web] message:", err);
    res.status(500).json({ error: "server_error", ...(process.env.NODE_ENV !== "production" ? { detail: err.message } : {}) });
  }
});

// POST /note { app_user_id, text, from? } — the app backend adds an assistant line to
// her chat (e.g. "I've opened ticket #12 for you"), so it stays in her history.
router.post("/note", async (req, res) => {
  try {
    const b = req.body || {};
    const text = String(b.text || "").trim().slice(0, 1000);
    if (!b.app_user_id || !text) return res.status(400).json({ error: "app_user_id and text are required" });
    let lead = await leadFor(b.app_user_id);
    if (!lead) {
      const { findOrLinkLead } = require("../app_integration/handlers");
      ({ lead } = await findOrLinkLead({ app_user_id: b.app_user_id, phone: b.phone, email: b.email, name: b.name }));
    }
    // from: "me" = her own words (e.g. the problem she reported), else Luna/Fiza.
    const mine = b.from === "me";
    const m = await addMessage(lead, mine ? { from: "user", direction: "IN", text } : { from: "bot", direction: "OUT", text });
    pushToReps(req, lead, m);
    res.json({ messages: [asChat(m)] });
  } catch (err) {
    console.error("[fiza-web] note:", err);
    res.status(500).json({ error: "server_error" });
  }
});

module.exports = router;
