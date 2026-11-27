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

/**
 * The campaign she replied to, if a campaign messaged her in the last 45
 * days: its name, the exact message she got, and its offer + end date
 * (migration 048). Lines for the prompt, or [] when there is none.
 */
async function campaignContext(leadId, now = new Date()) {
  let row = null;
  try {
    const [rows] = await sequelize.query(
      `SELECT c.name, c.offer_text, DATE_FORMAT(c.offer_ends_at, '%Y-%m-%d') AS offer_ends, cr.rendered_body, cr.sent_at
         FROM campaign_recipients cr JOIN campaigns c ON c.campaign_id = cr.campaign_id
        WHERE cr.lead_id = :id AND cr.sent_at IS NOT NULL AND cr.sent_at >= DATE_SUB(NOW(), INTERVAL 45 DAY)
        ORDER BY cr.sent_at DESC LIMIT 1`,
      { replacements: { id: leadId } }
    );
    row = rows[0] || null;
  } catch (e) {
    // Migration 048 not run: same lookup without the offer columns.
    if (!/offer_/i.test(String(e.message || ""))) return [];
    const [rows] = await sequelize.query(
      `SELECT c.name, cr.rendered_body, cr.sent_at
         FROM campaign_recipients cr JOIN campaigns c ON c.campaign_id = cr.campaign_id
        WHERE cr.lead_id = :id AND cr.sent_at IS NOT NULL AND cr.sent_at >= DATE_SUB(NOW(), INTERVAL 45 DAY)
        ORDER BY cr.sent_at DESC LIMIT 1`,
      { replacements: { id: leadId } }
    ).catch(() => [[]]);
    row = rows[0] || null;
  }
  return campaignLines(row, now);
}

/** Pure: the prompt lines for one campaign row (testable without a DB). */
function campaignLines(row, now = new Date()) {
  if (!row) return [];
  const lines = ["# THE CAMPAIGN SHE REPLIED TO"];
  const sent = row.sent_at ? new Date(row.sent_at).toISOString().slice(0, 10) : null;
  if (row.rendered_body) {
    lines.push(`On ${sent || "a recent day"} we sent her this message: "${String(row.rendered_body).replace(/\s+/g, " ").trim().slice(0, 400)}"`);
  }
  if (row.offer_text) {
    const today = new Date(now.getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10); // PKT date
    if (!row.offer_ends || row.offer_ends >= today) {
      lines.push(`The offer in it is real and still running: ${row.offer_text}${row.offer_ends ? ` (ends ${row.offer_ends})` : ""}. You may remind her of it, with the end date if there is one. Do not change or add to it.`);
    } else {
      lines.push(`That campaign's offer (${row.offer_text}) ENDED on ${row.offer_ends}. Do not offer it or hint it is still available. If she asks, say it has ended and share the current plans.`);
    }
  } else if (row.rendered_body) {
    lines.push("Stay consistent with that message. Do not invent a discount or deadline that isn't in it.");
  }
  return lines;
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

    const campaign = await campaignContext(person.id);
    const pastMember = person.stage === "churned"
      ? "She is a PAST FitHer member (paid before, plan has ended). Write as a welcome back: she knows us, don't explain FitHer from scratch, no first-time pitch."
      : "";

    const followupBlock = [
      "# THIS IS A FOLLOW-UP, NOT A REPLY",
      `She has not replied for about ${human(hoursSilent)}. Write ONE short follow-up message to send now (1–2 sentences, max ~40 words).`,
      `Step ${stepIndex + 1} of ${totalSteps}. Purpose of these follow-ups: ${aimFor(templateKey)}.`,
      stepGuide(stepIndex, totalSteps),
      `Write in ${lang} (the language of her last message).`,
      "Don't repeat a line, number or question we already sent in the chat above.",
      "No guilt (never 'you didn't reply'), no scare or health-risk claims, no made-up numbers or offers.",
      "A short greeting is fine after a long gap; use her first name at most once.",
      pastMember,
      idea ? `Old template idea (reference only — do NOT copy its wording, numbers or claims): ${idea}` : "",
      ...campaign,
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

module.exports = { writeFollowup, languageOf, campaignContext, campaignLines };
