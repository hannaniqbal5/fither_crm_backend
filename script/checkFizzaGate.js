/**
 * checkFizzaGate.js — read-only. Shows every condition that decides whether
 * Fizza will AUTO-REPLY to a lead's next inbound message.
 * Usage: node script/checkFizzaGate.js 1
 */
require("dotenv").config();
const sequelize = require("../src/config/database");

(async () => {
  const leadId = parseInt(process.argv[2] || "1");
  const ok = (b) => (b ? "✅" : "❌");
  try {
    const [[lead]] = await sequelize.query(
      "SELECT id, phone, name, stage, fizza_handled, assigned_to FROM leads WHERE id = :id",
      { replacements: { id: leadId } }
    );
    if (!lead) { console.log("Lead not found"); return; }

    let paused = false;
    try {
      const [r] = await sequelize.query(
        "SELECT setting_value v FROM layer_system_settings WHERE setting_key='automation_sends_paused' LIMIT 1");
      paused = String(r[0] && r[0].v || "0") === "1";
    } catch (e) { console.log("(pause setting unreadable:", e.message, ")"); }

    const agentOn   = process.env.AI_AGENT_ENABLED === "true";
    const copilot   = process.env.AI_COPILOT_MODE !== "false";
    const outDis    = process.env.OUTBOUND_DISABLED === "1";
    const allowlist = (process.env.OUTBOUND_ALLOWLIST || "").split(",").map(s=>s.trim()).filter(Boolean);
    const digits    = String(lead.phone||"").replace(/[^0-9]/g,"");
    const allowed   = !outDis || allowlist.some(a => digits.endsWith(a.replace(/[^0-9]/g,"").slice(-10)));

    console.log(`\nLead #${lead.id}  ${lead.phone}  stage=${lead.stage}\n`);
    console.log(`${ok(agentOn)} AI_AGENT_ENABLED=true            -> Fizza generates a reply`);
    console.log(`${ok(lead.stage !== "user")} stage is not "user"              -> (paying customers are skipped)`);
    console.log(`${ok(!!lead.fizza_handled)} fizza_handled = ${lead.fizza_handled}                 -> set by sending from Fizza Chats`);
    console.log(`${ok(!paused)} automation_sends_paused = ${paused ? 1 : 0}      -> master kill switch`);
    console.log(`${ok(allowed)} outbound allowed for this number  -> OUTBOUND_DISABLED=${outDis?1:0}, allowlist=[${allowlist.join(", ")}]`);
    console.log(`   (copilot mode = ${copilot}; with fizza_handled set, copilot is overridden)`);

    const willAutoSend = agentOn && lead.stage !== "user" && !!lead.fizza_handled && !paused && allowed;
    console.log(`\n${willAutoSend ? "✅ Fizza WILL auto-reply" : "❌ Fizza will NOT auto-reply"} to this lead's next message.`);
    if (!willAutoSend) console.log("   Fix whichever line above shows ❌.");
    console.log("   (Escalations such as mental-health flags always block auto-send.)");
  } catch (e) {
    console.log("Error:", e.message);
  } finally { await sequelize.close(); }
})();
