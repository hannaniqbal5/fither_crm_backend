// Migration runner — executes a .sql file with multi-statement support.
// Usage: node script/runMigration.js migrations/003_phase3_ai.sql
const fs    = require("fs");
const path  = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config();

// Same resolution as src/config/database.js: DB_* env vars when DB_NAME is
// set, else config.json[DB_PROFILE || "development"] (never NODE_ENV).
function resolveDbConfig() {
  if (process.env.DB_NAME) {
    return {
      database: process.env.DB_NAME,
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      host:     process.env.DB_HOST || "localhost",
      port:     process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    };
  }
  const profile = process.env.DB_PROFILE || "development";
  const all = require("../src/config/config.json");
  if (!all[profile]) throw new Error(`DB_PROFILE "${profile}" not found in src/config/config.json`);
  return all[profile];
}
const cfg = resolveDbConfig();

const file = process.argv[2];
if (!file) { console.error("Usage: node script/runMigration.js <sql-file>"); process.exit(1); }

const sql = fs.readFileSync(path.resolve(file), "utf8");

(async () => {
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.username,
    password: cfg.password, database: cfg.database,
    multipleStatements: true,
  });
  try {
    await conn.query(sql);
    console.log(`✅ ${path.basename(file)} applied`);
  } catch (e) {
    console.error(`❌ ${path.basename(file)} failed:`, e.sqlMessage || e.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
})();
