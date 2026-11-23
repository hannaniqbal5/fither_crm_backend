/**
 * followupTemplates.js — Layer 5 message templates.
 *
 * Key = `${interaction_status}__${main_goal || 'any'}`
 * Each entry: { silence_hours, tier ('tier1_auto'|'tier2_draft'), variants[] }
 *
 * Variants are picked round-robin by template_key to avoid the same lead
 * seeing the same exact message twice.
 *
 * Placeholders supported in body:
 *   {{name}}        — customer name (or "ma'am" if null)
 *   {{plan_price}}  — locked text "1-month PKR 3,500 / 2-month PKR 5,000 / 3-month PKR 6,000"
 */

const PLAN_PRICE_LINE = "1-month PKR 3,500 / 2-month PKR 5,000 / 3-month PKR 6,000";

const TEMPLATES = {
  // ── Engagement ──────────────────────────────────────────────
  "new_inbound__any": {
    silence_hours: 24, tier: "tier2_draft",
    variants: [
      "Hello {{name}}, hope you're doing well. We saw your message — want me to share how FitHer helps women like you reach their wellness goal? What's the one thing you'd most want to improve in the next 3 months?",
    ],
  },
  "awaiting_reply__any": {
    silence_hours: 6, tier: "tier1_auto",
    variants: [
      "Hello {{name}}, just following up on my last message — happy to answer any questions whenever you're free.",
      "Hello {{name}}, in case you missed my message, I'm here whenever you'd like to continue.",
    ],
  },

  // ── Warm / qualifying ────────────────────────────────────────
  "asking_about_program__pcos": {
    silence_hours: 24, tier: "tier1_auto",
    variants: [
      "Hello {{name}}, just checking in — for PCOS, our program combines hormone-friendly workouts + a PCOS-specific diet plan. Many of our members see cycle improvement within 8 weeks. Want me to share which plan suits your case best?",
    ],
  },
  "asking_about_program__postpartum": {
    silence_hours: 24, tier: "tier1_auto",
    variants: [
      "Hello {{name}}, our postpartum program focuses on core rebuilding + safe gradual progression — designed for new mothers. May I know how many months post-delivery you are so I can suggest the right starting point?",
    ],
  },
  "asking_about_program__weight_loss": {
    silence_hours: 24, tier: "tier1_auto",
    variants: [
      "Hello {{name}}, our weight-loss program is built around home workouts + a sustainable diet — most members lose 4–6 kg in 12 weeks without crash diets. What's your target timeline?",
    ],
  },
  "asking_about_program__weight_gain": {
    silence_hours: 24, tier: "tier1_auto",
    variants: [
      "Hello {{name}}, our healthy weight-gain track focuses on muscle + a high-protein diet — most members gain 3–5 kg in 12 weeks. May I ask if there's a medical reason for the underweight, so I can suggest the right plan?",
    ],
  },
  "asking_about_program__any": {
    silence_hours: 24, tier: "tier1_auto",
    variants: [
      "Hello {{name}}, just following up — our program is fully women-only, includes live classes + diet support. What's your main goal so I can guide you to the right plan?",
    ],
  },

  "asking_about_price__any": {
    silence_hours: 6, tier: "tier1_auto",
    variants: [
      // Single-anchor pricing — lead with cheapest, ask goal in same message
      "Hello {{name}}, hum 3,500 se start hote hain. Pehle batayein aap ka main goal kya hai — PCOS, weight loss, postpartum, ya general fitness? Phir mein aapko exactly bata sakti hoon kaun sa plan suits karega.",
    ],
  },
  "comparing_plans__any": {
    silence_hours: 12, tier: "tier1_auto",
    variants: [
      // Anchor 3-month to value, not to price
      "Hello {{name}}, 3 mahine ka plan lein to actual results dikhte hain — first month sirf body adjust hoti hai. Aap ke goal ke hisaab se 3-month plan strongly suggest karti hoon. Kya aap commit kar sakti hain 3 mahine ke liye?",
    ],
  },
  "discussing_with_family__any": {
    silence_hours: 48, tier: "tier2_draft",
    variants: [
      "Hello {{name}}, hope the family conversation went well. To share with them: it's women-only, you can do it from home, and your data is private. Want me to send a 2-line summary you can forward?",
    ],
  },
  "requesting_trial__any": {
    silence_hours: 4, tier: "tier2_draft",
    variants: [
      "Hello {{name}}, for the trial — I can set you up with one live class this week. Which day works: Tuesday, Thursday, or Saturday?",
    ],
  },

  // ── Objections ──────────────────────────────────────────────
  "price_negotiation__any": {
    silence_hours: 24, tier: "tier2_draft",
    variants: [
      // Daily-cost reframe + concession
      "Hello {{name}}, let me share something — 1-month plan toh actually PKR 117/day banta hai, ek samosa se kam. Phir bhi agar budget tight hai to 2-month plan @ 5,000 lein to better value milti hai. Kya aap is mein interest rakhti hain?",
    ],
  },
  "price_objection__any": {
    silence_hours: 168, tier: "tier2_draft", // 7 days
    variants: [
      // Daily-cost reframe + social proof + soft loss aversion
      "Hello {{name}}, last week aap ko plan mehnga laga tha. Sochiye is tarah — PKR 117/day, jitna chai pe roz kharch hota hai. Hamare 247+ members ne ye decision liya aur 8 weeks mein actual change dekha. Aap ka decision bilkul aapka, but ek baat — wait karna sirf wapas se start karne ki mehnat barhata hai.",
    ],
  },
  "timing_objection__any": {
    silence_hours: 336, tier: "tier1_auto", // 14 days
    variants: [
      // Soft loss aversion + concrete social proof
      "Hello {{name}}, 2 hafte pehle aap ne kaha tha 'abhi nahi'. Bas check kar rahi hoon — 14 din mein body adjustment ka phase aage badh chuka hota. Hamare new batch ke 18 members iss hafte start kar rahi hain. Aap join karein to coach assignment same week mein mil jayegi.",
    ],
  },
  "medical_concern__any": {
    silence_hours: 24, tier: "tier2_draft",
    variants: [
      "Hello {{name}}, hope you're feeling better. Whenever you're ready, we can adjust the workouts around your medical situation — many members with similar concerns are members. Take your time.",
    ],
  },
  "husband_blocking__any": {
    silence_hours: 168, tier: "tier2_draft", // 7 days
    variants: [
      "Hello {{name}}, just checking in — if it would help, we have a short note explaining the program for family members. Would you like me to send it?",
    ],
  },
  "will_start_later__any": {
    silence_hours: 168, tier: "tier1_auto", // 7 days first
    variants: [
      "Hello {{name}}, just a gentle reminder — you mentioned wanting to start a bit later. Whenever you're ready, message me and I'll set you up.",
    ],
  },

  // ── Hot / closing ───────────────────────────────────────────
  "callback_scheduled__any": {
    // Fired 1h BEFORE agreed time as a push to rep — not a customer message
    silence_hours: -1, tier: "tier2_draft",
    variants: [
      "[REP REMINDER — not sent to customer] Your callback with {{name}} is in 1 hour. Open the lead now.",
    ],
  },
  "ready_to_pay__any": {
    silence_hours: 2, tier: "tier1_auto",
    variants: [
      "Hello {{name}}, just confirming — should I send you the payment link now? You can pick the plan that works for you.",
    ],
  },
  "payment_link_sent__any": {
    silence_hours: 24, tier: "tier1_auto",
    variants: [
      "Hello {{name}}, in case you're stuck on the payment page — let me know and I can walk you through it, or send the bank details instead.",
    ],
  },
  "payment_pending__any": {
    silence_hours: 1, tier: "tier1_auto",
    variants: [
      "Hello {{name}}, we received your payment confirmation — verifying now. Your plan will activate within an hour, I'll message you the moment it's live.",
    ],
  },

  // ── Dead / closed ───────────────────────────────────────────
  "not_interested__any": {
    silence_hours: 2160, tier: "tier2_draft", // 90 days
    variants: [
      "Hello {{name}}, hope you're doing well. It's been a while since we spoke — if your wellness goals have changed, our program has too. Open to a quick chat?",
    ],
  },
  // ghosted has its own goal-specific templates
  "ghosted__pcos": {
    silence_hours: 72, tier: "tier1_auto",
    variants: [
      // Loss aversion + specific social proof
      "Hello {{name}}, 3 din pehle aap ne PCOS ke baare mein bataya tha. Untreated PCOS 5 saal mein diabetes risk 4x bharta hai — aur har month aapki cycle reset asaan se mushkil hoti jaati hai. Hamare 247 PCOS members ne ye decision liya — 8 weeks mein cycle regular hui. Kya aap 1 mahina try karna chahengi?",
    ],
  },
  "ghosted__weight_loss": {
    silence_hours: 72, tier: "tier1_auto",
    variants: [
      // Loss aversion + specific number
      "Hello {{name}}, 3 din pehle aap ne weight loss ki baat ki thi. Sach ye hai — belly fat 1 mahina mein zyada bharta hai jitna 3 mahine mein ja sakta hai. Average member 12 weeks mein 5.8 kg lose karti hai, woh bhi crash diet ke bina. Roz PKR 117 mein ye possible hai. Start karna chahengi?",
    ],
  },
  "ghosted__weight_gain": {
    silence_hours: 72, tier: "tier1_auto",
    variants: [
      // Specific number + reassurance
      "Hello {{name}}, healthy weight gain ke baare mein aap ne 3 din pehle poocha tha. Hamare members average 3–5 kg gain karti hain 12 weeks mein — proper muscle ke saath, sirf fat nahi. Coach aapke type ke hisaab se personalized plan deti hai. Kya aap starter plan dekhna chahengi?",
    ],
  },
  "ghosted__postpartum": {
    silence_hours: 72, tier: "tier1_auto",
    variants: [
      // Loss aversion + specific number
      "Hello {{name}}, hope aap aur baby theek hain. Ek baat zaroori share karni hai — postpartum diastasis (core gap) 6 mahine mein theek hota hai, 1 saal baad surgery hi option rehti hai. Hamare 89 postpartum mothers ne 16 weeks mein core strength wapas lai. Aap apne baby ke pehle saal mein khud ko priority dey sakti hain — start karna chahengi?",
    ],
  },
  "ghosted__diabetes": {
    silence_hours: 72, tier: "tier1_auto",
    variants: [
      // Loss aversion + specific authority signal
      "Hello {{name}}, 3 din pehle aap ne sugar ke baare mein bataya tha. Pre-diabetic stage mein reverse karna asaan hai, full diabetes hone ke baad medication permanent ho jaati hai. Hamare diabetes-friendly diet + low-impact workouts ne members ki HbA1c 12 weeks mein gira di hai. Coach se baat karna chahengi?",
    ],
  },
  "ghosted__any": {
    silence_hours: 72, tier: "tier1_auto",
    variants: [
      "Hello {{name}}, just checking in — if you'd still like to know more about FitHer, I'm here whenever you have a moment.",
    ],
  },
};

// ── Sequences (Nov 2026) ─────────────────────────────────────────────────
// Hours of silence SINCE HER LAST MESSAGE for each follow-up step. Step 1
// fires at steps[0], step 2 at steps[1], … then the sequence stops until she
// writes again (which starts a new sequence). Max 3 steps — matches the
// max_consecutive_followups safety cap.
// `aim` tells Fiza what that status's follow-ups are for; the template
// variants above are only an idea for her, never sent word for word.
const SEQUENCES = {
  new_inbound:            { steps: [24],            aim: "she wrote once and went quiet: a warm, short nudge about what she asked" },
  awaiting_reply:         { steps: [6, 48],         aim: "she hasn't answered our last question: make it easy to reply" },
  asking_about_program:   { steps: [24, 72, 168],   aim: "she asked how the program works: one useful detail tied to her goal, then an easy next step" },
  asking_about_price:     { steps: [6, 48, 168],    aim: "she asked the price: lowest plan + what it includes, then the smallest next step" },
  comparing_plans:        { steps: [12, 72],        aim: "she is choosing a plan: help her pick ONE for her goal" },
  discussing_with_family: { steps: [48, 168],       aim: "she is asking family: offer the short note she can forward; no pressure" },
  requesting_trial:       { steps: [4, 48],         aim: "she wants a trial: help her book it / join one class" },
  price_negotiation:      { steps: [24, 72, 168],   aim: "price is the question: closer-to-budget option (2-month = PKR 2,500/month), then value, then a last gentle check" },
  price_objection:        { steps: [24, 72, 168],   aim: "she found it expensive: closer-to-budget option first, then value, then a last gentle check" },
  timing_objection:       { steps: [72, 336],       aim: "she said not now: no pressure; check in later, ask if timing is better now" },
  medical_concern:        { steps: [48, 168],       aim: "health worry: caring check-in, program supports women like her, doctor advice first" },
  husband_blocking:       { steps: [72, 168],       aim: "family isn't sure: offer the short note for family; never tell her to override them" },
  will_start_later:       { steps: [168, 336],      aim: "she will start later: friendly check if now is a good time" },
  callback_scheduled:     { steps: [],              aim: "" },
  ready_to_pay:           { steps: [2, 24],         aim: "she was ready to pay: help her finish (payment details / any blocker)" },
  payment_link_sent:      { steps: [24, 72],        aim: "she has the payment link: ask if anything is stuck, offer help" },
  payment_pending:        { steps: [1],             aim: "her payment is being checked: reassure, plan activates soon" },
  not_interested:         { steps: [2160],          aim: "she said no long ago: one respectful check-in, no pitch" },
  ghosted:                { steps: [72, 168],       aim: "she went quiet mid-conversation: pick up her last topic, no guilt, no scare tactics" },
};

/** Steps (hours since her last message) for a template key. */
function stepsFor(key) {
  const status = String(key || "").split("__")[0];
  const seq = SEQUENCES[status];
  if (seq) return seq.steps;
  const t = TEMPLATES[key];
  return t && t.silence_hours >= 0 ? [t.silence_hours] : [];
}
function aimFor(key) {
  const seq = SEQUENCES[String(key || "").split("__")[0]];
  return (seq && seq.aim) || "a short, friendly follow-up on her last topic";
}

/**
 * keyFor — derives the template key from interaction_status + main_goal.
 * Falls back to `${status}__any` if no goal-specific template exists.
 */
function keyFor(status, goal) {
  if (!status) return null;
  const specific = `${status}__${goal || "any"}`;
  if (TEMPLATES[specific]) return specific;
  return TEMPLATES[`${status}__any`] ? `${status}__any` : null;
}

/**
 * pickVariant — round-robin picker. Caller can pass a counter for randomness.
 */
function pickVariant(key, counter = 0) {
  const t = TEMPLATES[key];
  if (!t || !t.variants.length) return null;
  return t.variants[counter % t.variants.length];
}

function renderTemplate(text, person) {
  return (text || "")
    .replace(/{{name}}/g, (person && person.name) || "ma'am")
    .replace(/{{plan_price}}/g, PLAN_PRICE_LINE);
}

module.exports = { TEMPLATES, SEQUENCES, stepsFor, aimFor, keyFor, pickVariant, renderTemplate, PLAN_PRICE_LINE };
