// Migration runner with tracking.
//
// Every applied file is recorded in `schema_migrations`, so a file never runs
// twice and you can always see what a database has.
//
//   node script/runMigration.js --status            list applied / pending
//   node script/runMigration.js --all               run every pending file, in order
//   node script/runMigration.js migrations/040_x.sql   run one file (skipped if already applied)
//   node script/runMigration.js migrations/040_x.sql --force   run it again anyway
//   node script/runMigration.js --baseline          ONE-TIME on an existing database:
//                                                   mark every current file as applied
//                                                   WITHOUT running it
//   node script/runMigration.js --mark-applied migrations/040_x.sql
//                                                   record one file as applied, don't run it
//
// Files are tracked by filename, so the two 003_ and two 004_ files are
// separate entries and order is plain filename order.
const fs    = require("fs");
const path  = require("path");
const crypto = require("crypto");
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

const DIR = path.join(__dirname, "..", "migrations");
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const fileArg = args.find((a) => !a.startsWith("--"));

const allFiles = () => fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

async function ensureTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(190) NOT NULL PRIMARY KEY,
      checksum   CHAR(64)     NOT NULL,
      how        ENUM('ran','baseline','marked') NOT NULL DEFAULT 'ran',
      applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
}
async function applied(conn) {
  const [rows] = await conn.query("SELECT filename, checksum, how, applied_at FROM schema_migrations");
  return new Map(rows.map((r) => [r.filename, r]));
}
async function record(conn, filename, text, how) {
  await conn.query(
    "INSERT INTO schema_migrations (filename, checksum, how) VALUES (?, ?, ?) " +
    "ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), how = VALUES(how), applied_at = NOW()",
    [filename, sha(text), how]
  );
}
async function runOne(conn, filename) {
  const text = fs.readFileSync(path.join(DIR, filename), "utf8");
  await conn.query(text);
  // Recorded only after the whole file succeeded. (MySQL DDL can't be rolled
  // back, so a file that fails half-way must be fixed and re-run by hand.)
  await record(conn, filename, text, "ran");
  console.log(`✅ ${filename} applied`);
}

(async () => {
  if (!fileArg && !flag("--all") && !flag("--status") && !flag("--baseline")) {
    console.error("Usage: node script/runMigration.js (--status | --all | --baseline | <file> [--force] | --mark-applied <file>)");
    process.exit(1);
  }
  const cfg = resolveDbConfig();
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.username,
    password: cfg.password, database: cfg.database,
    multipleStatements: true,
  });
  try {
    await ensureTable(conn);
    const done = await applied(conn);
    const files = allFiles();

    if (flag("--status")) {
      console.log(`Database: ${cfg.database}`);
      for (const f of files) {
        const r = done.get(f);
        const changed = r && r.checksum !== sha(fs.readFileSync(path.join(DIR, f), "utf8"));
        console.log(`${r ? (r.how === "ran" ? "applied " : r.how.padEnd(8)) : "PENDING "}  ${f}${changed ? "   (file changed since it was applied)" : ""}`);
      }
      return;
    }

    if (flag("--baseline")) {
      if (done.size > 0) {
        console.error(`schema_migrations already has ${done.size} rows — baseline is only for a database that has never been tracked.`);
        process.exit(1);
      }
      for (const f of files) await record(conn, f, fs.readFileSync(path.join(DIR, f), "utf8"), "baseline");
      console.log(`📌 Marked ${files.length} files as already applied (not run). Check with --status.`);
      return;
    }

    if (flag("--mark-applied")) {
      const name = path.basename(fileArg || "");
      if (!files.includes(name)) { console.error(`No such migration: ${name}`); process.exit(1); }
      await record(conn, name, fs.readFileSync(path.join(DIR, name), "utf8"), "marked");
      console.log(`📌 ${name} marked as applied (not run)`);
      return;
    }

    if (flag("--all")) {
      const pending = files.filter((f) => !done.has(f));
      if (!pending.length) { console.log("Nothing pending."); return; }
      for (const f of pending) await runOne(conn, f);
      return;
    }

    const name = path.basename(fileArg);
    if (!files.includes(name)) { console.error(`No such migration in migrations/: ${name}`); process.exit(1); }
    if (done.has(name) && !flag("--force")) {
      console.log(`⏭  ${name} already applied on ${new Date(done.get(name).applied_at).toISOString()} — skipped (use --force to run again)`);
      return;
    }
    await runOne(conn, name);
  } catch (e) {
    console.error(`❌ failed:`, e.sqlMessage || e.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
})();
