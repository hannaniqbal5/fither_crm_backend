const fs=require("fs");const p="src/ai/reply.service.js";let s=fs.readFileSync(p,"utf8");
function rep(a,b){ if(!s.includes(a)) throw new Error("not found: "+a.slice(0,70)); s=s.replace(a,b); }
rep("const ESCALATE_REGEX = /<ESCALATE\\s+reason=\"([^\"]+)\"\\s*\\/>/i;",
`const ESCALATE_REGEX = /<ESCALATE\\s+reason="([^"]+)"\\s*\\/>/i;

/** Did we (Fiza or a rep) message her in the last 12h? Then it's mid-conversation. */
async function isMidConversation(personId) {
  try {
    const last = await Message.findOne({
      where: { lead_id: personId, direction: "OUT" },
      order: [["created_at", "DESC"]],
      attributes: ["created_at"],
    });
    return !!(last && Date.now() - new Date(last.created_at).getTime() < 12 * 60 * 60 * 1000);
  } catch (_) { return false; }
}

/** Strip the formatting tells that make a WhatsApp text look machine-written. */
function humanize(text, midConversation) {
  let t = String(text || "");
  t = t.replace(/\\*\\*(.+?)\\*\\*/g, "$1").replace(/(^|\\s)\\*(\\S.*?\\S)\\*(?=\\s|$)/g, "$1$2"); // bold / italics
  t = t.replace(/^#{1,6}\\s+/gm, "");                         // headings
  t = t.replace(/\\s*[—–]\\s*/g, ", ").replace(/,\\s*,/g, ",");  // long dashes → comma
  t = t.replace(/!{2,}/g, "!");
  if (midConversation) {
    // Drop a leading "Hello ma'am," / "Hi ma'am!" — nobody re-greets mid-chat.
    t = t.replace(/^(\\[TEST\\]\\s*)?(hello|hi|hey)\\s+(ma['’]?am|mam)\\s*[,!.]?\\s*/i, "$1");
    t = t.replace(/^(\\[TEST\\]\\s*)?([a-z])/, (m, pre, c) => (pre || "") + c.toUpperCase());
  }
  return t.replace(/[ \\t]{2,}/g, " ").trim();
}`);
rep("    const history = await getRecentConversation(person.id);",
"    const history = await getRecentConversation(person.id);\n    const midConversation = await isMidConversation(person.id);");
rep("      sourceWasVoice,\n      journeyContext,", "      sourceWasVoice,\n      journeyContext,\n      midConversation,");
rep("    const cleanReply = rawReply.replace(ESCALATE_REGEX, \"\").trim();",
"    const cleanReply = humanize(rawReply.replace(ESCALATE_REGEX, \"\").trim(), midConversation);");
rep("module.exports = { generateReply };", "module.exports = { generateReply, humanize };");
fs.writeFileSync(p,s);console.log("ok");
