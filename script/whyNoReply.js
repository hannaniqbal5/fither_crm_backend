/**
 * whyNoReply.js — read-only. Shows what Fizza actually did with a lead's
 * recent messages: did she generate a reply, was it sent, or was it blocked?
 * Usage: node script/whyNoReply.js 1
 */
require("dotenv").config();
const sequelize = require("../src/config/database");

(async () => {
  const leadId = parseInt(process.argv[2] || "1");
  try {
    const [[lead]] = await sequelize.query(
      "SELECT id, phone, stage, fizza_handled, interaction_status FROM leads WHERE id = :id",
      { replacements: { id: leadId } });
    if (!lead) { console.log("Lead not found"); return; }
    console.log(`\nLead #${lead.id} ${lead.phone} stage=${lead.stage} fizza_handled=${lead.fizza_handled} status=${lead.interaction_status}`);

    let paused = "0";
    try {
      const [r] = await sequelize.query(
        "SELECT setting_value v FROM layer_system_settings WHERE setting_key='automation_sends_paused' LIMIT 1");
      paused = String((r[0] && r[0].v) || "0");
    } catch (_) {}
    console.log(`automation_sends_paused = ${paused}${paused === "1" ? "   <-- BLOCKS ALL AUTO-SEND" : ""}`);

    const [last] = await sequelize.query(
      `SELECT id, direction, \`from\`, message_type, LEFT(message, 60) AS msg, created_at
         FROM messages WHERE lead_id = :id ORDER BY id DESC LIMIT 6`,
      { replacements: { id: leadId } });
    console.log("\n--- last 6 messages (newest first) ---");
    last.forEach(m => console.log(`  #${m.id} ${m.direction} from=${m.from} [${m.message_type}] ${m.created_at} "${m.msg || ""}"`));

    const [reps] = await sequelize.query(
      `SELECT reply_id, message_id, status, escalate_reason, confidence,
              LEFT(ai_response, 70) AS reply, LEFT(error_message, 80) AS err, created_at, sent_at
         FROM ai_replies WHERE lead_id = :id ORDER BY created_at DESC LIMIT 6`,
      { replacements: { id: leadId } });
    console.log("\n--- last 6 AI replies (newest first) ---");
    if (!reps.length) console.log("  (none — Fizza never generated a reply for this lead)");
    reps.forEach(r => {
      console.log(`  ${r.created_at} status=${r.status}${r.sent_at ? " sent_at=" + r.sent_at : ""} conf=${Number(r.confidence||0).toFixed(2)}${r.escalate_reason ? "  ESCALATE=" + r.escalate_reason : ""}`);
      console.log(`     msg_id=${r.message_id} reply="${r.reply || ""}"${r.err ? "  ERROR=" + r.err : ""}`);
    });

    console.log("\nHow to read this:");
    console.log("  status=sent              -> she replied, it went out");
    console.log("  status=draft + ESCALATE  -> she wrote it but escalation blocked the send");
    console.log("  status=draft, no escalate-> copilot/gate blocked it (check fizza_handled + pause)");
    console.log("  no rows for a new inbound-> generation never ran (AI off, stage=user, or opt-out)");
  } catch (e) {
    console.log("Error:", e.message);
  } finally { await sequelize.close(); }
})();
