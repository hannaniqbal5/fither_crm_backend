/**
 * intentDetector.js — Layer 1 of the FitHer Layer System.
 *
 * Pure keyword/regex detection. Runs synchronously on every inbound message.
 * Returns:
 *   { interaction_status, main_goal, last_objection, score_delta, matched_rules }
 *
 * Layer 1 is fast, deterministic, and cheap. Layer 2 (Gemini classifier)
 * runs ASYNC after this — it can correct/augment what Layer 1 detected.
 *
 * If Layer 1 returns nothing meaningful, the system falls back to the
 * lead's previous state (no churn).
 *
 * Designed for Roman Urdu + English messages from Pakistani customers.
 */

// ──────────────────────────────────────────────────────────────────────
// Score weight table — must match LAYER_SYSTEM_SPEC.md §6 exactly
// ──────────────────────────────────────────────────────────────────────
const SCORE_DELTAS = {
  ready_to_pay:          +50,
  payment_pending:       +30,
  requesting_trial:      +25,
  callback_scheduled:    +25,
  price_negotiation:     +20,
  comparing_plans:       +15,
  asking_about_price:    +10,
  discussing_with_family:+10,
  asking_about_program:   +5,
  medical_concern:        +5,
  active_chat:            +2,
  awaiting_reply:          0,
  will_start_later:        0,  // Nov 2026: still engaged — no penalty (was -2)
  timing_objection:        0,  // Nov 2026: "abhi nahi" is not "no" (was -5)
  price_objection:        +5,  // Nov 2026: objecting to price = engaged, closable (was -10)
  husband_blocking:       +5,  // Nov 2026: she wants it, family is the step (was -10)
  ghosted:               -15,
  not_interested:    "RESET", // → set lead_score = 0
  wrong_number:      "RESET",
  lost_to_competitor:"RESET",
  opted_out:         "LOCK",  // → set lead_score = -100
};

// ──────────────────────────────────────────────────────────────────────
// MAIN GOAL — keyword regex per goal
// ──────────────────────────────────────────────────────────────────────
const GOAL_PATTERNS = [
  {
    goal: "pcos",
    regex: /\b(pcos|pcod|hormon|periods? (irregular|miss|nahi|nahin)|cyst|ovari|facial hair|hirsut|baal jhar|hair fall|insulin resist)\b/i,
  },
  {
    goal: "postpartum",
    regex: /\b(post\-?partum|delivery|c\-?section|baby ke baad|bachay ke baad|feeding (mom|mother)|breastfeed|after pregnancy|core weak|tummy nahi ja)\b/i,
  },
  {
    goal: "diabetes",
    regex: /\b(diabet|sugar (high|level)|hba1c|insulin|pre\-?diabetic|sugar ki problem|doctor ne kaha sugar)\b/i,
  },
  {
    goal: "weight_gain",
    regex: /\b(wazan barhan|weight gain|patli|underweight|muscle banan|bulk up|patl[ai] hoon|under\-?weight|wazan kam hai)\b/i,
  },
  {
    goal: "weight_loss",
    regex: /\b(wazan kam|lose weight|weight loss|belly fat|tummy fat|inches kam|fat loss|slim|moti hoon|moti hu|motapa|wazan zyada)\b/i,
  },
  {
    goal: "general",
    regex: /\b(fitness|healthy|tone(d)?|wellness|active rehna|energy|stamina|exercise routine)\b/i,
  },
];

// ──────────────────────────────────────────────────────────────────────
// LAST OBJECTION — keyword regex
// ──────────────────────────────────────────────────────────────────────
const OBJECTION_PATTERNS = [
  {
    objection: "price",
    regex: /\b(m[ae]hng[aei]?|expensive|costly|zyada\s+(hai|hain|hn|h)\b|bahut\s+zyada|boh?o?u?n?t\s+zyada|discount|sasta|afford|pais[aey]+\s*(nahi|nahin|n[ai]i?|ni)|budget|k[a]?m\s+k[ra]?r?\s*(o|ein|en|na|lain|lein|lo|do)?|k[a]?m\s+pais[aey]+|pais[aey]+\s+k[a]?m|too\s+much|over\s*budget)\b/i,
  },
  {
    objection: "timing",
    regex: /\b(time\s+(nahi|nahin|n[ai]i?|ni)|busy\s+(hoon|hu|hun)|abhi\s+(nahi|nahin|n[ai]i?|ni)|next\s+month|baad\s+mein|baad\s+m[ei]n|later|not\s+(now|right\s+now)|exams|travel|busy)\b/i,
  },
  {
    objection: "family",
    regex: /\b(husband|shohar|mian|in\-?laws|sasural|family allow|ghar wale|mama|papa|parent|mom mana)\b/i,
  },
  {
    objection: "medical",
    regex: /\b(thyroid|bp|blood pressure|surgery|operation|doctor mana|injury|knee pain|back pain|medical issue|sehat theek nahi)\b/i,
  },
  {
    objection: "fit",
    regex: /\b(suit nahi|fit nahi|sahi nahi|not right|not for me|kuch aur try|different program|not sure)\b/i,
  },
];

// ──────────────────────────────────────────────────────────────────────
// INTERACTION STATUS — ordered: more specific / higher-intent first
// First match wins.
// ──────────────────────────────────────────────────────────────────────
const STATUS_PATTERNS = [
  // Group E — dead/closed (must check first so we don't misroute)
  {
    status: "opted_out",
    // Same rules as the DNC detector, so "dont stop sending workouts" or
    // "stop button not working" are NOT treated as an opt-out (bare /stop/ was).
    regex: { test: (t) => !!require("../broadcast/optOutDetector").detectOptOutKeyword(t), source: "optOutDetector" },
  },
  {
    status: "wrong_number",
    regex: /\b(wrong number|galat number|kiska number|kisi aur ka number|not mine|main nahin hoon)\b/i,
  },
  {
    status: "lost_to_competitor",
    regex: /\b(another app|dusri app|other (program|app)|already (joined|using)|kahin aur join|sweat\&snack|fitr|home workout app)\b/i,
  },
  {
    status: "not_interested",
    regex: /\b(not\s+interested|interested\s+(nahi|nahin|n[ai]i?|ni)|(nahi|nahin|n[ai]i?|ni)\s+chah?i?ye|don'?t\s+want|no\s+thanks|mujhe\s+(nahi|nahin|n[ai]i?|ni)\s+chah?i?ye)\b/i,
  },

  // Group D — hot / closing
  {
    status: "ready_to_pay",
    regex: /\b(pay\s+k[ra]?r?\s*(na|n[ae]\s+chah?ti|n[ae]\s+chah?ta|ne)?|pay\s+now|payment\s+k[ra]?r?|pay\s+(ready|chah?ti\s+hoon|chah?ti\s+hu)|pais[aey]+\s+bhej\w*|kah[aa]?n\s+pais[aey]+|kah[aa]?n\s+bhej|account\s+number\s+do|payment\s+details|join\s+(kaise|krna|karna)|le\s+leti\s+(hoon|hu)|lena\s+(chah?ti\s+hoon|chah?ta\s+hoon|hai)|sign\s?up|enrol+\s?me|account\s+bhejo|ready\s+(hoon|hu)|kis\s+account\s+(p[ae]r|m[ei]n)|3[\-\s]?month\s+(le|plan)\s+(leti|lena)|2[\-\s]?month\s+(le|plan)\s+(leti|lena)|theek\s+(hai|h)\s+mam.*(le|lena|join|pay))\b/i,
  },
  {
    status: "payment_pending",
    regex: /\b(paise bhej diye|payment done|slip|receipt|transfer (kar diya|done|kiya)|paid|paid kar diya|done payment)\b/i,
  },
  {
    status: "payment_link_sent",
    // Used by system when sending; rarely customer-triggered
    regex: /^__never_match__$/,
  },
  {
    status: "callback_scheduled",
    regex: /\b(call (karo|karein|me|kar lo)|baat (kar(o|ein)?)|video call|zoom|consultation (book|chahiye)|call at|baat kar lein)\b/i,
  },

  // Group C — objections
  {
    status: "husband_blocking",
    regex: /\b(husband\s+(nahi|nahin|n[ai]i?|ni|mana)|shohar\s+(nahi|nahin|n[ai]i?|ni)|mian\s+allow\s+(nahi|nahin|n[ai]i?|ni)|ghar\s+wale\s+(nahi|nahin|n[ai]i?|ni)|family\s+allow\s+(nahi|nahin|n[ai]i?|ni)|sasural\s+(nahi|nahin|n[ai]i?|ni))\b/i,
  },
  {
    status: "medical_concern",
    regex: /\b(medical\s+(issue|problem)|surgery\s+hui|operation|doctor\s+(ne\s+)?(kaha|mana|consult|advice)|knee\s+pain|back\s+pain|joint\s+pain|injury|pregnant\s+(hoon|hu)|periods\s+(nahi|nahin|n[ai]i?|ni)|cyst|thyroid|hba1c|sehat\s+theek\s+(nahi|nahin|n[ai]i?|ni))\b/i,
  },
  {
    status: "price_objection",
    regex: /\b(bah?o?u?n?t\s+m[ae]hng|bah?o?u?n?t\s+zyada|too\s+expensive|afford\s+(nahi|nahin|n[ai]i?|ni)|pais[aey]+\s+(nahi|nahin|n[ai]i?|ni)|out\s+of\s+budget|itne?\s+pais[aey]+\s+(nahi|nahin|n[ai]i?|ni)|m[ae]hng[aei]?\s+(hai|hain|hn|h)\b|n[ai]i?\s+afford|zyada\s+(hai|hain)\b)\b/i,
  },
  {
    status: "price_negotiation",
    regex: /\b(discount|sasta|offer|deal|kuch\s+concession|installment|emi|easy\s+installment|k[a]?m\s+k[ra]?r?\s*(o|ein|en|na|lain|lein|lo|do)?\s*(pais[aey]+)?|k[a]?m\s+pais[aey]+|pais[aey]+\s+k[a]?m|2000|3000|reduce\s+(price|paise|pais[aey]+)|kam\s+kar|chot[ai]\s+amount)\b/i,
  },
  {
    status: "timing_objection",
    regex: /\b(abhi\s+busy|abhi\s+(nahi|nahin|n[ai]i?|ni)|time\s+(nahi|nahin|n[ai]i?|ni)|baad\s+m[ei]n|later|not\s+(right\s+)?now|maybe\s+later|next\s+month|(ramzan|ramadan|eid|exams?|shaadi|wedding|delivery|vacation|chutti(y[ao]n)?)\s+ke\s+baad|after\s+(ramadan|ramzan|eid|exams?|the\s+wedding)|busy\s+(hoon|hu|hun|hai)|filhal\s+(nahi|nahin|n[ai]i?))\b/i,
  },
  {
    status: "will_start_later",
    regex: /\b(next month start|kal se|next week|2 mahine baad|after exams|january se|new year se)\b/i,
  },

  // Group B — warm / qualifying
  {
    status: "requesting_trial",
    regex: /\b(trial|demo|free class|first class free|ek baar try|sample|try kar)\b/i,
  },
  {
    status: "comparing_plans",
    regex: /\b(1 month|2 month|3 month|kaun sa (plan|behtar)|monthly|three month|which plan|all plans|sab plans)\b/i,
  },
  {
    status: "discussing_with_family",
    regex: /\b(husband se pooch|ghar wale se|sasural mein bata|family discuss|mama se pooch|husband ko bata)\b/i,
  },
  {
    status: "asking_about_price",
    regex: /\b(kitn(e|a) ka|price|fee|amount|charges?|rate|cost|kitn(e|a) paisay|rs\.?|pkr|monthly fee)\b/i,
  },
  {
    status: "asking_about_program",
    regex: /\b(kya hai|what is|fither (kya|kaisa)|program|kaise kaam|how it works|tell me about|info|details|batao)\b/i,
  },
];

// Anything else that's clearly a "first ever message"
const NEW_INBOUND_HINT = /\b(hi|hello|asalam|salam|hey|assalamu)\b/i;

// ──────────────────────────────────────────────────────────────────────
// detect() — pure function, no side effects
// ──────────────────────────────────────────────────────────────────────

function detectGoal(text) {
  for (const p of GOAL_PATTERNS) {
    if (p.regex.test(text)) return p.goal;
  }
  return null;
}

function detectObjection(text) {
  for (const p of OBJECTION_PATTERNS) {
    if (p.regex.test(text)) return p.objection;
  }
  return null;
}

// Returns { status, fallback } — fallback=true when no keyword matched and the
// status is only the generic default (so it must not clobber a real status).
function detectStatus(text, lead) {
  for (const p of STATUS_PATTERNS) {
    if (p.regex.test(text)) return { status: p.status, fallback: false };
  }
  // No keyword matched — infer from context
  if (lead && !lead.interaction_status) {
    if (NEW_INBOUND_HINT.test(text)) return { status: "new_inbound", fallback: true };
    return { status: "new_inbound", fallback: true };
  }
  return { status: "active_chat", fallback: true }; // Default: lead is still chatting
}

/**
 * detect — public API
 * @param {string} text   — customer message body
 * @param {object} [lead] — Sequelize People row (or POJO) — used for context
 * @returns {object}
 */
function detect(text, lead = null) {
  const clean = (text || "").trim();
  if (!clean) {
    return {
      interaction_status: null,
      main_goal: null,
      last_objection: null,
      score_delta: 0,
      matched_rules: [],
    };
  }

  const { status, fallback: statusFallback } = detectStatus(clean, lead);
  const goal       = detectGoal(clean);
  const objection  = detectObjection(clean);

  // Compute score delta
  const raw = SCORE_DELTAS[status];
  let score_delta = 0;
  let score_op    = "delta";  // delta | reset | lock
  if (raw === "RESET") {
    score_op = "reset";
    score_delta = 0;
  } else if (raw === "LOCK") {
    score_op = "lock";
    score_delta = -100;
  } else if (typeof raw === "number") {
    score_delta = raw;
  }

  return {
    interaction_status: status,
    status_fallback: statusFallback, // true = default guess, no keyword matched
    main_goal: goal,
    last_objection: objection,
    score_delta,
    score_op,
    matched_rules: [
      status ? `status:${status}` : null,
      goal ? `goal:${goal}` : null,
      objection ? `objection:${objection}` : null,
    ].filter(Boolean),
  };
}

/**
 * funnelStageFor — derive funnel_stage (1-5) from current lead state.
 * Run after intent detector + state merge.
 */
function funnelStageFor(lead) {
  const s = lead.interaction_status;
  const HOT = ["callback_scheduled","ready_to_pay","payment_link_sent","payment_pending","onboarded"];
  const OBJ = ["price_negotiation","price_objection","timing_objection","medical_concern","husband_blocking","will_start_later"];
  const PRICING = ["asking_about_price","comparing_plans"];

  if (HOT.includes(s))     return 5;
  if (OBJ.includes(s) || (lead.last_objection && lead.last_objection !== "none")) return 4;
  if (PRICING.includes(s)) return 3;
  if (lead.main_goal)      return 2;
  return 1;
}

module.exports = {
  detect,
  funnelStageFor,
  SCORE_DELTAS,
  GOAL_PATTERNS,
  OBJECTION_PATTERNS,
  STATUS_PATTERNS,
};
