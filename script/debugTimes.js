/**
 * debugTimes.js — shows the raw stored times for one app user on both sides,
 * to check that no time is shifted by the server time zone.
 *   node script/debugTimes.js 255
 */
require("dotenv").config();
const mysql = require("mysql2/promise");
const sequelize = require("../src/config/database");
(async () => {
  const u = String(process.argv[2] || "");
  const [[tz]] = await sequelize.query("SELECT @@global.time_zone AS global_tz, @@session.time_zone AS session_tz, CAST(NOW() AS CHAR) AS db_now");
  console.log("CRM DB clock:", tz, " | real UTC now:", new Date().toISOString());
  const [rows] = await sequelize.query(
    "SELECT JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.occurred_at')) AS sent_occurred_at, CAST(e.occurred_at AS CHAR) AS event_occurred_raw, CAST(e.received_at AS CHAR) AS received_raw, CAST(l.app_signed_up_at AS CHAR) AS signed_up_raw FROM app_events e LEFT JOIN leads l ON l.id = e.lead_id WHERE e.app_user_id = :u",
    { replacements: { u } }
  );
  console.table(rows);
  const app = await mysql.createConnection({ uri: process.env.PARTNER_DB_URL, dateStrings: true });
  const [ur] = await app.query("SELECT id, createdAt FROM Users WHERE id = ?", [u]);
  const [ob] = await app.query("SELECT eventType, createdAt, JSON_UNQUOTE(JSON_EXTRACT(payload,'$.occurred_at')) AS payload_occurred_at FROM CrmOutbox WHERE userId = ?", [u]);
  console.log("App DB user row (raw):", ur);
  console.log("App DB outbox (raw):", ob);
  await app.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
