// migrationCheck.js — which migrations does THIS database really have?
//
// schema_migrations only started tracking in Nov 2026, so on an older database
// almost every file shows "PENDING" even though it ran long ago. This reads
// each untracked file, finds what it creates (tables, added columns, indexes)
// and looks for them in the live database:
//
//   present  everything it creates exists          → safe to mark as applied
//   missing  nothing it creates exists             → run it
//   partial  some of it exists                     → look at it by hand
//   unknown  it only changes data / column types   → look at it by hand
//
//   node script/migrationCheck.js           report only, changes nothing
//   node script/migrationCheck.js --mark    also record the "present" ones as applied
//                                            (how = 'marked'), so --status is true
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const DIR = path.join(__dirname, "..", "migrations");
const MARK = process.argv.includes("--mark");

function dbConfig() {
  if (process.env.DB_NAME) {
    return { database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
      host: process.env.DB_HOST || "localhost", port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306 };
  }
  const c = require("../src/config/config.json")[process.env.DB_PROFILE || "development"];
  return { database: c.database, user: c.username, password: c.password, host: c.host, port: c.port || 3306 };
}

const clean = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const name = (s) => s.replace(/`/g, "");

function whatItCreates(sql) {
  const s = clean(sql);
  const items = [];
  for (const m of s.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi)) items.push({ kind: "table", table: name(m[1]) });
  for (const m of s.matchAll(/ALTER\s+TABLE\s+`?(\w+)`?([\s\S]*?);/gi)) {
    const t = name(m[1]);
    for (const c of m[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi)) items.push({ kind: "column", table: t, column: name(c[1]) });
    for (const c of m[2].matchAll(/ADD\s+(?:UNIQUE\s+)?(?:INDEX|KEY)\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi)) items.push({ kind: "index", table: t, index: name(c[1]) });
  }
  for (const m of s.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s+ON\s+`?(\w+)`?/gi)) items.push({ kind: "index", table: name(m[2]), index: name(m[1]) });
  return items;
}

(async () => {
  const cfg = dbConfig();
  const conn = await mysql.createConnection({ ...cfg, multipleStatements: true });
  const db = cfg.database;
  const [tables] = await conn.query("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [db]);
  const [cols] = await conn.query("SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?", [db]);
  const [idx] = await conn.query("SELECT DISTINCT TABLE_NAME t, INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?", [db]);
  const T = new Set(tables.map((r) => r.t.toLowerCase()));
  const C = new Set(cols.map((r) => `${r.t}.${r.c}`.toLowerCase()));
  const I = new Set(idx.map((r) => `${r.t}.${r.i}`.toLowerCase()));
  let applied = new Map();
  try {
    const [rows] = await conn.query("SELECT filename FROM schema_migrations");
    applied = new Map(rows.map((r) => [r.filename, true]));
  } catch (_) { /* never tracked */ }

  const has = (it) => it.kind === "table" ? T.has(it.table.toLowerCase())
    : it.kind === "column" ? C.has(`${it.table}.${it.column}`.toLowerCase())
    : I.has(`${it.table}.${it.index}`.toLowerCase());
  const show = (it) => it.kind === "table" ? `table ${it.table}` : it.kind === "column" ? `${it.table}.${it.column}` : `index ${it.index} on ${it.table}`;

  const files = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const out = { present: [], missing: [], partial: [], unknown: [] };
  for (const f of files) {
    if (applied.has(f)) continue;
    const text = fs.readFileSync(path.join(DIR, f), "utf8");
    const items = whatItCreates(text);
    if (!items.length) { out.unknown.push({ f }); continue; }
    const yes = items.filter(has), no = items.filter((i) => !has(i));
    const bucket = !no.length ? "present" : !yes.length ? "missing" : "partial";
    out[bucket].push({ f, text, no: no.map(show) });
  }

  console.log(`Database: ${db}\n`);
  console.log(`✅ Already in the database (${out.present.length}):`);
  out.present.forEach((x) => console.log(`   ${x.f}`));
  console.log(`\n❌ Missing — run these, in this order (${out.missing.length}):`);
  out.missing.forEach((x) => console.log(`   node script/runMigration.js migrations/${x.f}`));
  console.log(`\n⚠️  Partly there — check by hand (${out.partial.length}):`);
  out.partial.forEach((x) => console.log(`   ${x.f}   missing: ${x.no.join(", ")}`));
  console.log(`\n❔ Can't tell (changes data / types only) (${out.unknown.length}):`);
  out.unknown.forEach((x) => console.log(`   ${x.f}`));

  if (MARK && out.present.length) {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(190) NOT NULL PRIMARY KEY, checksum CHAR(64) NOT NULL,
      how ENUM('ran','baseline','marked') NOT NULL DEFAULT 'ran', applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    for (const x of out.present) {
      await conn.query(
        "INSERT INTO schema_migrations (filename, checksum, how) VALUES (?, ?, 'marked') ON DUPLICATE KEY UPDATE how = how",
        [x.f, crypto.createHash("sha256").update(x.text).digest("hex")]
      );
    }
    console.log(`\nMarked ${out.present.length} file(s) as applied. "--status" now shows them as applied.`);
  } else if (out.present.length) {
    console.log(`\nRun again with --mark to record the ${out.present.length} present file(s) as applied.`);
  }
  await conn.end();
})().catch((e) => { console.error("Check failed:", e.message); process.exit(1); });
