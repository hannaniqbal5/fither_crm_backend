/**
 * setAutomationPause.js — turn the master automation kill-switch on/off.
 * Same setting the /api/messaging-analytics/automation-pause endpoint writes.
 *
 *   node script/setAutomationPause.js off   -> resume automated sends (Fizza replies)
 *   node script/setAutomationPause.js on    -> pause all automated sends
 *   node script/setAutomationPause.js       -> just show the current value
 */
const sequelize = require("../src/config/database");

(async () => {
  const arg = (process.argv[2] || "").toLowerCase();
  try {
    const read = async () => {
      const [r] = await sequelize.query(
        "SELECT setting_value v FROM layer_system_settings WHERE setting_key='automation_sends_paused' LIMIT 1");
      return String((r[0] && r[0].v) || "0");
    };

    const before = await read();
    console.log(`\nCurrent: automation_sends_paused = ${before} (${before === "1" ? "PAUSED" : "running"})`);

    if (arg !== "on" && arg !== "off") {
      console.log("No change. Pass 'off' to resume automated sends, 'on' to pause.");
      return;
    }
    const v = arg === "on" ? "1" : "0";
    await sequelize.query(
      `INSERT INTO layer_system_settings (setting_key, setting_value)
       VALUES ('automation_sends_paused', :v)
       ON DUPLICATE KEY UPDATE setting_value = :v`,
      { replacements: { v } }
    );
    console.log(`Now:     automation_sends_paused = ${v} (${v === "1" ? "PAUSED" : "running"})`);
    if (v === "0") console.log("\n✅ Fizza can now auto-reply. WhatsApp sends are still limited to OUTBOUND_ALLOWLIST.");
  } catch (e) {
    console.log("Error:", e.message);
  } finally { await sequelize.close(); }
})();
