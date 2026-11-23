/**
 * followupWriter.js — Fiza writes each follow-up herself (Nov 2026).
 *
 * The follow-up engine used to send fixed template text ("Hello {{name}}, …"),
 * in one language, with made-up numbers in some. Now it asks Fiza to write the
 * follow-up from the real conversation: her language, her topic, our rules
 * (human voice, real facts only), and the purpose of this step in the
 * sequence. The old template text is only passed as an idea.
 *
 * Uses the background model (GEMINI_LLM_MODEL, Flash) — operation
 * "followup_draft" — so follow-ups stay cheap even when replies use Pro.
 * Returns null on any failure; the engine then falls back to the template
 * (drafts only — a rep still approves it).
 */

const sequelize = require("../config/database");
const { generateText } = require("./gemini.client");
const { retrieve } = require("./retrieval.service");
const { buildSystemPrompt } = require("./prompt.builder");
const { pickMode } = require("./modeRouter");
const { aimFor, pickVariant, renderTemplate } = require("./followupTemplates");

const URDU_HINT = /\b(hai|hain|kya|kaise|kab|mein|mujhe|aap|ap|nahi|nhi|kr|kar|karna|chahiye|theek|thik|acha|accha|bata|batao|kitne|kitna|se|ka|ki|ko|ho|raha|rahi)\b/i;
const languageOf = (t) => {
  const s = String(t || "");
  if (/[؀-ۿ]/.test(s)) return "Urdu script";
  if (/[a-z]/i.test(s) && !URDU_HINT.test(s)) return "English";
  return "Roman Urdu";
};

const human = (h) => (h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} hours`);

async function recentChat(leadId) {
  const [rows] = await sequelize.query(
    `SELECT direction, \`from\`, message, message_type FROM messages
      WHERE lead_id = :id ORDER BY id DESC LIMIT 12`,
    { replacements: { id: leadId } }
  );
  const list = rows.reverse();
  const history = list
    .map((m) => `${m.direction === "IN" ? "User" : "Fiza/Rep"}: ${(m.message || `[${m.message_type}]`).replace(/\s+/g, " ").trim()}`)
    .join("\n");
  const lastIn = [...list].reverse().find((m) => m.direction === "IN" && m.message);
  return { history, lastInText: lastIn ? lastIn.message : "" };
}

function stepGuide(stepIndex, total) {
  if (total <= 1) return "This is the only follow-up: warm, short, easy to answer.";
  if (stepIndex === 0) return "First follow-up: pick up her last topic warmly and make it easy to reply.";
  if (stepIndex === total - 1) {
    return "LAST follow-up: a gentle final check. Say you won't keep messaging and she can write anytime. No new pitch.";
  }
  return "Middle follow-up: share ONE new useful point she hasn't heard yet (from the knowledge), then a light question.";
}

/**
 * @returns {Promise<string|null>}
 */
async function writeFollowup(person, templateKey, { stepIndex = 0, totalSteps = 1, hoursSilent = 24 } = {}) {
  try {
    const { history, lastInText } = await recentChat(person.id);
    const lang = languageOf(lastInText);
    const { mode } = pickMode(person, lastInText || "");
    const chunks = await retrieve(lastInText || person.main_goal || "FitHer program", { mode }).catch(() => []);
    const idea = renderTemplate(pickVariant(templateKey, 0) || "", person);

    const followupBlock = [
      "# THIS IS A FOLLOW-UP, NOT A REPLY",
      `She has not replied for about ${human(hoursSilent)}. Write ONE short follow-up message to send now (1–2 sentences, max ~40 words).`,
      `Step ${stepIndex + 1} of ${totalSteps}. Purpose of these follow-ups: ${aimFor(templateKey)}.`,
      stepGuide(stepIndex, totalSteps),
      `Write in ${lang} (the language of her last message).`,
      "Don't repeat a line, number or question we already sent in the chat above.",
      "No guilt (never 'you didn't reply'), no scare or health-risk claims, no made-up numbers or offers.",
      "A short greeting is fine after a long gap; use her first name at most once.",
      idea ? `Old template idea (reference only — do NOT copy its wording, numbers or claims): ${idea}` : "",
    ].filter(Boolean).join("\n");

    const systemPrompt = buildSystemPrompt(chunks, history, mode, [], [], {
      journeyContext: followupBlock,
      midConversation: false,
      intentContext: {
        interaction_status: person.interaction_status,
        main_goal: person.main_goal,
        last_objection: person.last_objection,
        lead_score: person.lead_score,
        name: person.name,
      },
    });

    const raw = await generateText(
      "Write the follow-up message now. Reply with ONLY the message text.",
      systemPrompt,
      { operation: "followup_draft", lead_id: person.id }
    );
    const { humanize } = require("./reply.service");
    const text = humanize(String(raw || "").replace(/<ESCALATE[^>]*\/>/gi, "").trim(), false);
    return text || null;
  } catch (e) {
    console.error(`[followupWriter] lead ${person.id} failed:`, e.message);
    return null;
  }
}

module.exports = { writeFollowup, languageOf };
