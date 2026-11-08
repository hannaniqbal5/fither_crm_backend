/**
 * layer2Classifier.js — Layer 2 of the FitHer Layer System.
 *
 * Gemini-powered classifier that REFINES Layer 1's keyword detection.
 * Where Layer 1 uses regex (fast, deterministic), Layer 2 uses an LLM to
 * disambiguate edge cases ("she said weight gain but in the context of
 * gaining muscle, so still weight_gain" / "she said PCOS but really meant
 * thyroid").
 *
 * Runs ASYNC (fire-and-forget) after Layer 1 has already updated the row.
 * If Layer 2 returns a HIGHER-CONFIDENCE classification, it overrides L1.
 *
 * Output:
 *   { main_goal, last_objection, interaction_status, confidence, reasoning }
 *
 * Cost: ~1 cent per 100 inbound messages (gemini-2.5-flash, ~200 tokens out).
 * Toggle off via LAYER2_ENABLED=false if you want pure regex / save cost.
 */

const sequelize = require("../config/database");
const { loadHistory } = require("./intentHistory");
const { generateText } = require("./gemini.client");

const SYSTEM_PROMPT = `You are a CRM intent classifier for FitHer (women's wellness app, Pakistan).
Given the customer's latest message + recent conversation context, output STRICTLY this JSON
(no prose, no markdown fence, just the JSON object):

{
  "main_goal": "pcos | weight_loss | weight_gain | postpartum | diabetes | general | null",
  "last_objection": "price | timing | family | medical | fit | none",
  "interaction_status": "<one of the 24 values>",
  "confidence": 0.0-1.0,
  "reasoning": "<one short sentence>"
}

24 interaction_status values:
new_inbound, awaiting_reply, active_chat, ghosted,
asking_about_program, asking_about_price, comparing_plans, discussing_with_family, requesting_trial,
price_negotiation, price_objection, timing_objection, medical_concern, husband_blocking, will_start_later,
callback_scheduled, ready_to_pay, payment_link_sent, payment_pending, onboarded,
not_interested, wrong_number, lost_to_competitor, opted_out.

Rules:
- main_goal: null only if first message has NO clear goal signal. Prefer existing goal if customer doesn't change it.
- interaction_status: pick the MOST RECENT signal. If customer is asking price NOW, that overrides earlier active_chat.
- If confidence < 0.6, just return the lead's current values unchanged.
- weight_loss vs weight_gain: be careful — "wazan zyada hai" = weight_loss, "wazan kam hai" / "patli hoon" = weight_gain.
- PCOS + weight goal: keep main_goal as pcos (the condition is the primary lens).
- If a customer with PCOS says she also wants to lose weight, KEEP main_goal=pcos. Don't switch.

Examples:
[Customer]: "wazan kam karna hai shadi hai 3 month mein"
→ {"main_goal":"weight_loss","last_objection":"none","interaction_status":"asking_about_program","confidence":0.92,"reasoning":"Explicit weight loss + timeline event"}

[Customer]: "PCOS hai mujhe, periods 4 mahine se nahi aaye"
→ {"main_goal":"pcos","last_objection":"medical","interaction_status":"medical_concern","confidence":0.95,"reasoning":"PCOS condition stated, irregular cycle is medical context"}

[Customer]: "abhi husband se pooch ke batati hoon"
→ {"main_goal":null,"last_objection":"family","interaction_status":"discussing_with_family","confidence":0.88,"reasoning":"Family discussion before commitment"}

[Customer]: "bohot mehnga hai kuch discount?"
→ {"main_goal":null,"last_objection":"price","interaction_status":"price_negotiation","confidence":0.94,"reasoning":"Asking for discount = negotiating"}

[Customer]: "STOP"
→ {"main_goal":null,"last_objection":"none","interaction_status":"opted_out","confidence":0.99,"reasoning":"Explicit opt-out"}`;

const RECENT_TURNS = 4;

async function recentHistory(personId) {
  try {
    const { Message } = require("../../models");
    const rows = await Message.findAll({
      where: { lead_id: personId },
      order: [["created_at", "DESC"]],
      limit: RECENT_TURNS,
    });
    return rows.reverse().map(m => {
      const who = m.direction === "IN" ? "Customer" : "Rep";
      return `${who}: ${(m.message || "").replace(/\s+/g, " ").trim()}`;
    }).join("\n");
  } catch (e) {
    return "";
  }
}

function safeParse(raw) {
  if (!raw) return null;
  // Strip code fences / leading text
  const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

const VALID_STATUSES = new Set([
  "new_inbound","awaiting_reply","active_chat","ghosted",
  "asking_about_program","asking_about_price","comparing_plans","discussing_with_family","requesting_trial",
  "price_negotiation","price_objection","timing_objection","medical_concern","husband_blocking","will_start_later",
  "callback_scheduled","ready_to_pay","payment_link_sent","payment_pending","onboarded",
  "not_interested","wrong_number","lost_to_competitor","opted_out",
]);
const VALID_GOALS      = new Set(["pcos","weight_loss","weight_gain","postpartum","diabetes","general"]);
const VALID_OBJECTIONS = new Set(["price","timing","family","medical","fit","none"]);

/**
 * classify — public entry. NEVER throws.
 *
 * @param {object} person — Sequelize People row (post-Layer1, freshly reloaded)
 * @param {string} latestText
 * @returns {Promise<object|null>}
 */
async function classify(person, latestText) {
  if (process.env.LAYER2_ENABLED === "false") return null;
  if (!latestText || !latestText.trim()) return null;

  try {
    const history = await recentHistory(person.id);

    const userPrompt =
      `Lead current state (after Layer 1):\n` +
      `- interaction_status: ${person.interaction_status || "null"}\n` +
      `- main_goal: ${person.main_goal || "null"}\n` +
      `- last_objection: ${person.last_objection || "none"}\n\n` +
      (history ? `Recent conversation:\n${history}\n\n` : "") +
      `Latest customer message:\n"${latestText}"\n\n` +
      `Output the JSON object now.`;

    const raw = await generateText(userPrompt, SYSTEM_PROMPT, {
      operation: "classifier",
      lead_id: person.id,
    });
    const parsed = safeParse(raw);
    if (!parsed) {
      console.warn(`⚠️  [Layer2] Could not parse classifier output for lead ${person.id}`);
      return null;
    }

    // Sanitize
    const out = {
      main_goal: parsed.main_goal && VALID_GOALS.has(parsed.main_goal) ? parsed.main_goal : null,
      last_objection: parsed.last_objection && VALID_OBJECTIONS.has(parsed.last_objection) ? parsed.last_objection : "none",
      interaction_status: parsed.interaction_status && VALID_STATUSES.has(parsed.interaction_status) ? parsed.interaction_status : null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      reasoning: String(parsed.reasoning || "").slice(0, 200),
    };

    // Confidence floor — below 0.6, do nothing
    if (out.confidence < 0.6) {
      console.log(`🔎 [Layer2] Lead ${person.id} — confidence ${out.confidence.toFixed(2)} too low, skipping`);
      return out;
    }

    // Apply to People row — only if Layer 2 changes something
    const patch = {};
    if (out.interaction_status && out.interaction_status !== person.interaction_status) {
      patch.interaction_status = out.interaction_status;
    }
    if (out.main_goal && out.main_goal !== person.main_goal) {
      patch.main_goal = out.main_goal;
      patch.goal_detected_at = new Date();
    }
    if (out.last_objection && out.last_objection !== person.last_objection) {
      patch.last_objection = out.last_objection;
    }

    if (Object.keys(patch).length > 0) {
      patch.last_intent_detected_at = new Date();

      // Append to intent_history
      const history = [...loadHistory(person)];
      history.unshift({
        ts: new Date().toISOString(),
        source: "layer2_classifier",
        confidence: out.confidence,
        reasoning: out.reasoning,
        previous: {
          interaction_status: person.interaction_status,
          main_goal: person.main_goal,
          last_objection: person.last_objection,
        },
        next: patch,
      });
      patch.intent_history = history.slice(0, 10);

      await person.update(patch);
      console.log(
        `✨ [Layer2] Lead ${person.id} refined — ` +
        (patch.interaction_status ? `status→${patch.interaction_status} ` : "") +
        (patch.main_goal          ? `goal→${patch.main_goal} ` : "") +
        (patch.last_objection     ? `obj→${patch.last_objection} ` : "") +
        `(conf ${out.confidence.toFixed(2)})`
      );
    }

    return out;
  } catch (err) {
    console.error("❌ [Layer2] suppressed error:", err.message);
    return null;
  }
}

module.exports = { classify };
