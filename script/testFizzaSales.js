/**
 * testFizzaSales.js — run a scripted customer conversation through Fizza and
 * print her replies. SENDS NOTHING to WhatsApp; it only calls the AI and writes
 * the thread to a TEST lead so you can also read it in Fizza Chats.
 *
 * Usage: node script/testFizzaSales.js <leadId>
 *        node script/testFizzaSales.js 4          (lead 4 = 92300TEST001)
 */
require("dotenv").config();
const sequelize = require("../src/config/database");
const { People } = require("../models");
const { generateReply } = require("../src/ai/reply.service");

// A realistic buyer journey: cold -> goal -> price objection -> payment -> proof
const SCRIPT = [
  "Assalam o alaikum, ye kya hai?",
  "Mera weight bohat barh gaya hai, PCOS bhi hai",
  "Price kya hai?",
  "Bohat mehnga hai, 2000 mein ho sakta hai?",
  "Theek hai main try karna chahti hoon, join kaise karun?",
  "Account number dubara bhej dein",
];

(async () => {
  const leadId = parseInt(process.argv[2] || "4");
  try {
    const person = await People.findByPk(leadId);
    if (!person) { console.log(`Lead ${leadId} not found`); return; }
    console.log(`\n=== Fizza sales test — lead #${person.id} (${person.phone}) ===`);
    console.log(`stage=${person.stage} goal=${person.main_goal} score=${person.lead_score}\n`);

    for (const line of SCRIPT) {
      // store the customer's message so Fizza has real conversation history
      const [ins] = await sequelize.query(
        `INSERT INTO messages (lead_id, \`from\`, message, direction, message_type, status, is_read, created_at, updated_at)
         VALUES (:id, 'customer', :m, 'IN', 'text', 'received', 1, NOW(), NOW())`,
        { replacements: { id: person.id, m: line } });
      const msgId = ins.insertId || ins;

      console.log(`👩 CUSTOMER: ${line}`);
      const t0 = Date.now();
      const out = await generateReply(person, line, msgId, {});
      const ms = Date.now() - t0;

      if (out.error || !out.reply) {
        console.log(`🤖 FIZZA: [no reply — ${out.error || "empty"}]\n`);
        continue;
      }
      console.log(`🤖 FIZZA (${(ms/1000).toFixed(1)}s, conf=${Number(out.confidence || 0).toFixed(2)}${out.escalate ? ", ESCALATE=" + out.escalate : ""}):`);
      console.log(out.reply.split("\n").map(l => "   " + l).join("\n") + "\n");

      await sequelize.query(
        `INSERT INTO messages (lead_id, \`from\`, message, direction, message_type, status, is_read, created_at, updated_at)
         VALUES (:id, 'ai', :m, 'OUT', 'text', 'sent', 1, NOW(), NOW())`,
        { replacements: { id: person.id, m: out.reply } });

      try { await person.reload(); } catch (_) {}
    }
    console.log("=== done — open this lead in Fizza Chats to review, then 🗑 Delete chat ===");
  } catch (e) {
    console.log("Error:", e.message);
  } finally { await sequelize.close(); }
})();
