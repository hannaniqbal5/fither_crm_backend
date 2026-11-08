/**
 * optOutDetector.js — detect "STOP / UNSUBSCRIBE / BAS KARO" replies and auto-DNC.
 *
 * Called from the inbound message.handler.js whenever a user message is saved.
 * If the message text matches an opt-out keyword, the lead is added to dnc_list.
 *
 * Idempotent — safe to call repeatedly.
 */

const sequelize = require("../config/database");

// Opt-out detection rules.
//   • Bare "stop" only counts when it is (almost) the whole message — "stop",
//     "STOP!", "please stop", "stop it". "dont stop sending workouts" or
//     "stop button not working" are NOT opt-outs.
//   • Phrase rules ("stop messaging me", "unsubscribe", "remove me", Roman Urdu
//     "bas karo", Urdu "تنگ نہ کریں" …) match anywhere, unless "stop"/
//     "unsubscribe" is directly negated ("don't stop", "never stop").
//   • Word boundaries are Unicode-aware (`\b` never matches next to Arabic-
//     script letters, so the old Urdu patterns could not match).
const L = "(?<![\\p{L}\\p{M}\\p{N}])"; // start-of-word (Unicode)
const R = "(?![\\p{L}\\p{M}\\p{N}])";  // end-of-word (Unicode)
const NEG = "(?<!(?:don'?t|dont|do not|never|not|didn'?t|won'?t|can'?t|cannot)\\s+)";
const rx = (body) => new RegExp(L + "(?:" + body + ")" + R, "iu");

// Whole-message "stop" variants (checked against punctuation/emoji-stripped text).
const URDU_DO = "(?:karo|kro|karein|karen|kren|kar\\s+do|kr\\s+do|kardo|krdo|kar\\s+dein|kr\\s+dein)";
const WHOLE_MESSAGE_STOP = new RegExp(
  "^(?:(?:please|pls|plz|plzz)\\s+)?" +
  "(?:stop+(?:\\s+stop+)*|stop\\s+it|stop\\s+now|stop\\s+this|stop\\s+sending|stop\\s+" + URDU_DO +
  "|unsubscribe|unsub|band\\s+" + URDU_DO + "|not\\s+interested\\s+stop|stop\\s+not\\s+interested)" +
  "(?:\\s+(?:please|pls|plz|now|it))?$",
  "iu"
);

const OPT_OUT_PATTERNS = [
  { label: "stop_messaging",   re: rx(NEG + "stop\\s+(?:messag(?:e|es|ing)|msg(?:s|ing)?|texting|contacting|calling|spamming|bothering|disturbing)(?:\\s+(?:me|us))?") },
  { label: "stop_sending",     re: rx(NEG + "stop\\s+sending(?:\\s+(?:me|us|messages?|msgs?|texts?|these|this))?(?=\\s*(?:$|[.!?,]))|" + NEG + "stop\\s+sending\\s+(?:me|us|messages?|msgs?|texts?|these|this)") },
  // "stop karo" / "stop kr do" anywhere (Roman Urdu stop-intent), not negated
  { label: "stop_karo",        re: rx(NEG + "stop\\s+" + URDU_DO) },
  // Message that STARTS with "stop" followed by punctuation: "STOP!!! dont message"
  { label: "stop_leading",     re: /^\s*stop+\s*[!.,]+\s*(?:$|(?:dont|don't|do\s+not|no\s+more|not\s+interested|pls|please|plz|bas|mat|band)(?![\p{L}\p{M}\p{N}]))/iu },
  { label: "unsubscribe",      re: rx(NEG + "unsubscribe") },
  { label: "remove_me",        re: rx("remove\\s+(?:me|my\\s+number)|take\\s+me\\s+off|delete\\s+my\\s+number") },
  { label: "do_not_contact",   re: rx("(?:do\\s+not|don'?t|dont)\\s+(?:contact|message|msg|text|call)(?:\\s+(?:me|us|again)|(?=\\s*(?:$|[.!?])))") },
  { label: "block_me",         re: rx("block\\s+me") },
  { label: "bas_karo",         re: rx("(?:bas|bus)\\s+(?:karo|kro|karein|karen|kren|kar\\s+do|krdo|kardo)") },
  { label: "band_karo",        re: rx("(?:message|messages|msg|msgs|sms|messaging|ye|yeh|sab)\\s+band\\s+(?:karo|kro|karein|karen|kren|kar\\s+do|krdo|kardo)") },
  { label: "message_mat_karo", re: rx("(?:message|messages|msg|msgs|sms)\\s+(?:mat|na|nah|nai|nahi|nahin)\\s+(?:karo|kro|karein|karen|kren|karna|krna|bhejo|bhejein|bhejen|bhejna)") },
  { label: "tang_mat_karo",    re: rx("tang\\s+(?:mat|na|nah)\\s+(?:karo|kro|karein|karen|kren|karna|krna)") },
  { label: "message_nahi_karna", re: rx("message\\s+nahin?\\s+karna") },
  { label: "mujhe_nahi_chahiye", re: rx("mujhe\\s+nahin?\\s+chahiye") },
  // Urdu script
  { label: "ur_tang_na_karein",  re: rx("تنگ\\s+(?:نہ|نا|مت)\\s+(?:کریں|کرو|کیجیے|کیجئے)") },
  { label: "ur_message_na_karein", re: rx("(?:میسج|میسیج|پیغام|پیغامات|میسجز)\\s+(?:نہ|نا|مت)\\s+(?:کریں|کرو|بھیجیں|بھیجو|کیجیے|کیجئے)") },
  { label: "ur_message_band",    re: rx("(?:میسج|میسیج|پیغام|پیغامات|میسجز)\\s+بند\\s+(?:کریں|کرو|کر\\s+دیں|کر\\s+دو)") },
  { label: "ur_bas_karein",      re: rx("بس\\s+(?:کریں|کرو|کر\\s+دیں|کر\\s+دو)") },
];

function _normalize(text) {
  return String(text)
    .replace(/[\u2018\u2019\u02BC`´]/g, "'")   // curly / odd apostrophes → '
    .replace(/[\u200B-\u200F\u061C]/g, "")       // zero-width / bidi marks
    .replace(/\s+/g, " ")
    .trim();
}

function detectOptOutKeyword(messageText) {
  if (!messageText || typeof messageText !== "string") return null;
  const t = _normalize(messageText);
  if (!t) return null;
  // Whole-message check: drop punctuation/emoji so "STOP!!" / "stop 🙏" match.
  const bare = t.replace(/[^\p{L}\p{M}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  if (WHOLE_MESSAGE_STOP.test(bare)) return "stop";
  for (const { label, re } of OPT_OUT_PATTERNS) {
    if (re.test(t)) return label;
  }
  return null;
}

async function markLeadOptedOut(lead) {
  try {
    await sequelize.query(
      `UPDATE leads
          SET interaction_status = 'opted_out', auto_followup_paused = 1
        WHERE id = :leadId`,
      { replacements: { leadId: lead.id } }
    );
    // Keep the caller's in-memory row in sync (message.handler passes the
    // Sequelize instance on to the intent detector right after this).
    if (lead && typeof lead.reload === "function") await lead.reload();
  } catch (err) {
    console.error(`❌ [optOut] could not flag lead ${lead.id} as opted_out:`, err.message);
  }
}

/**
 * checkAndRecordOptOut — call this whenever a user replies.
 * If the message contains an opt-out keyword, add to dnc_list.
 *
 * @param {object} lead — { id, phone, whatsapp_jid }
 * @param {string} messageText
 * @returns {Promise<{ optedOut: boolean, keyword?: string }>}
 */
async function checkAndRecordOptOut(lead, messageText) {
  const keyword = detectOptOutKeyword(messageText);
  if (!keyword) return { optedOut: false };

  try {
    // Mark the lead itself as opted out + pause auto follow-ups, so every
    // sender (sendGate, follow-up scan, campaigns) sees it. Idempotent.
    await markLeadOptedOut(lead);

    // Check if already in DNC
    const [existing] = await sequelize.query(
      `SELECT id FROM dnc_list WHERE lead_id = :leadId LIMIT 1`,
      { replacements: { leadId: lead.id } }
    );
    if (existing.length > 0) {
      return { optedOut: true, keyword, alreadyOnList: true };
    }

    await sequelize.query(
      `INSERT INTO dnc_list
         (lead_id, phone, whatsapp_jid, reason, matched_keyword, source_message)
       VALUES
         (:leadId, :phone, :jid, 'user_request', :keyword, :sourceMessage)`,
      {
        replacements: {
          leadId: lead.id,
          phone: lead.phone || null,
          jid: lead.whatsapp_jid || null,
          keyword: keyword.slice(0, 60),
          sourceMessage: (messageText || "").slice(0, 500),
        },
      }
    );

    // Also update any in-flight campaign_recipients to status='opted_out'
    await sequelize.query(
      `UPDATE campaign_recipients
          SET status = 'opted_out'
        WHERE lead_id = :leadId
          AND status IN ('queued','sending')`,
      { replacements: { leadId: lead.id } }
    );

    console.log(`🚫 [optOut] Lead ${lead.id} added to DNC (matched: ${keyword})`);

    return { optedOut: true, keyword };
  } catch (err) {
    console.error(`❌ [optOut] Failed for lead ${lead.id}:`, err.message);
    return { optedOut: false, error: err.message };
  }
}

/**
 * isOnDNC — quick check if a lead should be skipped.
 */
async function isOnDNC(leadId) {
  const [rows] = await sequelize.query(
    `SELECT id FROM dnc_list WHERE lead_id = :id LIMIT 1`,
    { replacements: { id: leadId } }
  );
  return rows.length > 0;
}

module.exports = { detectOptOutKeyword, checkAndRecordOptOut, isOnDNC };
