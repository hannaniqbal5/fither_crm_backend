const fs=require("fs");const p="src/routes/fizaChat.routes.js";let s=fs.readFileSync(p,"utf8");
function rep(a,b){ if(!s.includes(a)) throw new Error("nf: "+a.slice(0,60)); s=s.replace(a,b); }
// 1) helpers
rep("async function appJourney(lead, assistant) {", `// Her latest message looks English (no common Roman Urdu words) → reply in English.
const URDU_HINT = /\\b(hai|hain|kya|kaise|kab|mein|mujhe|aap|ap|nahi|nhi|kr|kar|karna|chahiye|theek|thik|acha|accha|bata|batao|kitne|kitna|se|ka|ki|ko|ho|raha|rahi)\\b/i;
const looksEnglish = (t) => /[a-z]/i.test(t) && !/[\\u0600-\\u06FF]/.test(t) && !URDU_HINT.test(t);

// Drop a trailing "what's your goal?" if Luna already asked it in this chat.
async function dropRepeatGoal(leadId, reply) {
  const GOAL_Q = /[^.!?\\n]*\\b(main goal|your goal|goal kya|goal hai)\\b[^.!?\\n]*\\?\\s*$/i;
  if (!GOAL_Q.test(reply)) return reply;
  const [rows] = await sequelize.query(
    "SELECT message FROM messages WHERE lead_id = :id AND direction = 'OUT' ORDER BY id DESC LIMIT 12",
    { replacements: { id: leadId } }
  );
  const askedBefore = rows.some((r) => /\\b(main goal|your goal|goal kya|goal hai)\\b/i.test(r.message || ""));
  if (!askedBefore) return reply;
  const trimmed = reply.replace(GOAL_Q, "").trim();
  return trimmed || reply;
}

async function appJourney(lead, assistant, latestText) {`);
rep(`    "LANGUAGE: reply in the language she writes in`, `    latestText && looksEnglish(latestText)
      ? "Her latest message is in ENGLISH: reply in English only, no Roman Urdu."
      : "",
    "LANGUAGE: reply in the language she writes in`);
rep("{ journeyContext: await appJourney(lead, b.assistant) }", "{ journeyContext: await appJourney(lead, b.assistant, text) }");
rep(`    if (r.reply) {
      await reply(r.reply);`, `    if (r.reply) {
      r.reply = await dropRepeatGoal(lead.id, r.reply);
      await reply(r.reply);`);
fs.writeFileSync(p,s);console.log("ok");
