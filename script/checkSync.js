/**
 * checkSync.js — shows whether app events reached the CRM (local testing).
 *   node script/checkSync.js            latest events
 *   node script/checkSync.js 254        also this app user's lead
 * Reads the app DB via PARTNER_DB_URL and the CRM DB via the normal config.
 */
require("dotenv").config();
const mysql = require("mysql2/promise");
const sequelize = require("../src/config/database");

(async () => {
  const userId = process.argv[2];
  try {
    if (!process.env.PARTNER_DB_URL) throw new Error("PARTNER_DB_URL missing in .env");
    const app = await mysql.createConnection(process.env.PARTNER_DB_URL);
    const [out] = await app.query(
      "SELECT id, eventType, userId, status, attempts, LEFT(COALESCE(lastError,''),80) AS lastError, createdAt, sentAt FROM CrmOutbox ORDER BY id DESC LIMIT 8"
    );
    console.log("\n== App backend: CrmOutbox (newest first)");
    console.table(out);
    await app.end();
  } catch (e) {
    console.log("App DB check failed:", e.message);
  }
  try {
    const [ev] = await sequelize.query(
      "SELECT event_type, app_user_id, status, lead_id, LEFT(COALESCE(error_message,''),60) AS error, received_at FROM app_events ORDER BY received_at DESC LIMIT 8"
    );
    console.log("\n== CRM: app_events (newest first)");
    console.table(ev);
    if (userId) {
      const [lead] = await sequelize.query(
        "SELECT id, name, phone, email, source, assigned_to, whatsapp_account_id, app_signed_up_at, app_onboarding_step, app_onboarded_at, subscription_status FROM leads WHERE app_user_id = :u",
        { replacements: { u: String(userId) } }
      );
      console.log(`\n== CRM: lead for app user ${userId}`);
      console.table(lead);
    }
  } catch (e) {
    console.log("CRM DB check failed:", e.message);
  }
  process.exit(0);
})();
