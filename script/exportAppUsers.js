#!/usr/bin/env node
/**
 * exportAppUsers.js — dump the app's users as JSON, to feed the backfill.
 *
 * WHY THIS EXISTS
 *   backfillAppUsers.js wants the app's user list. Neither HTTP route it tries
 *   exists yet: GET /internal/crm/users isn't built, and GET /admin/all-users
 *   (the one the original script was written against) returns 404 too. So the
 *   HTTP path could never have worked, and the fix needs an app-side endpoint.
 *
 *   Until then, read the list straight from the app's own database using the
 *   PARTNER_DB_URL you already have in .env. Read-only, one-time, local.
 *
 * USAGE (PowerShell)
 *   node script/exportAppUsers.js --list              show candidate tables
 *   node script/exportAppUsers.js                     writes app_users.json
 *   node script/exportAppUsers.js --out other.json    somewhere else
 *   node script/exportAppUsers.js --stdout            print instead of writing
 *   node script/exportAppUsers.js --table Users       force a table
 *
 *   Then:
 *   $env:DRY_RUN="1"
 *   Get-Content app_users.json | node script/backfillAppUsers.js --stdin
 *
 * NOTE
 *   JSON goes to stdout, progress goes to stderr, so `> app_users.json` gives
 *   you a clean file. This script never writes to either database.
 */

require("dotenv").config({ quiet: true });
const mysql = require("mysql2/promise");

const log = (...a) => console.error(...a);

// The app's column names are its own business, so match on what's there
// instead of assuming. First hit wins, in this order.
const PICK = {
  id:    ["id", "user_id", "userId", "uid", "_id"],
  phone: ["phone", "phone_number", "phoneNumber", "mobile", "mobile_number",
          "contact", "contact_number", "whatsapp", "whatsapp_number", "msisdn"],
  email: ["email", "email_address", "emailAddress", "user_email"],
  name:  ["name", "full_name", "fullName", "username", "first_name", "firstName", "display_name"],
};

function choose(columns, candidates) {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  for (const want of candidates) {
    const hit = lower.get(want.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

async function main() {
  if (!process.env.PARTNER_DB_URL) {
    log("PARTNER_DB_URL is not set in .env — cannot read the app database.");
    process.exit(1);
  }

  const conn = await mysql.createConnection(process.env.PARTNER_DB_URL);
  try {
    const [dbRow] = await conn.query("SELECT DATABASE() AS db");
    const dbName = dbRow[0] && dbRow[0].db;
    log(`Connected to app database: ${dbName}`);

    const [cols] = await conn.query(
      `SELECT TABLE_NAME, COLUMN_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?`,
      [dbName]
    );

    const byTable = new Map();
    for (const { TABLE_NAME, COLUMN_NAME } of cols) {
      if (!byTable.has(TABLE_NAME)) byTable.set(TABLE_NAME, []);
      byTable.get(TABLE_NAME).push(COLUMN_NAME);
    }

    // A user table is one with an id and at least a phone or an email.
    const candidates = [];
    for (const [table, columns] of byTable) {
      const id    = choose(columns, PICK.id);
      const phone = choose(columns, PICK.phone);
      const email = choose(columns, PICK.email);
      if (!id || (!phone && !email)) continue;
      let score = (phone ? 2 : 0) + (email ? 2 : 0);
      if (/^users?$/i.test(table)) score += 10;          // the obvious name
      else if (/user/i.test(table)) score += 3;
      if (/log|event|session|token|otp|device|notification/i.test(table)) score -= 8;
      candidates.push({ table, id, phone, email, name: choose(columns, PICK.name), score });
    }
    candidates.sort((a, b) => b.score - a.score);

    if (!candidates.length) {
      log("No table with an id plus a phone or email. Pass --table <name> explicitly.");
      process.exit(1);
    }

    if (process.argv.includes("--list")) {
      log("\nCandidate tables, best first:");
      for (const c of candidates.slice(0, 10)) {
        log(`  ${String(c.table).padEnd(28)} id=${c.id}  phone=${c.phone || "-"}  email=${c.email || "-"}  name=${c.name || "-"}  (score ${c.score})`);
      }
      log("");
      return;
    }

    const forcedIdx = process.argv.indexOf("--table");
    const forced = forcedIdx > -1 ? process.argv[forcedIdx + 1] : null;
    const chosen = forced
      ? candidates.find((c) => c.table.toLowerCase() === String(forced).toLowerCase())
      : candidates[0];

    if (!chosen) {
      log(`Table "${forced}" has no id plus phone/email. Try --list.`);
      process.exit(1);
    }

    log(`Reading from "${chosen.table}" (id=${chosen.id}, phone=${chosen.phone || "-"}, email=${chosen.email || "-"})`);
    if (!forced && candidates.length > 1) {
      log(`If that's the wrong table, run --list and pass --table <name>.`);
    }

    const sel = [
      `\`${chosen.id}\` AS id`,
      chosen.phone ? `\`${chosen.phone}\` AS phone` : `NULL AS phone`,
      chosen.email ? `\`${chosen.email}\` AS email` : `NULL AS email`,
      chosen.name  ? `\`${chosen.name}\`  AS name`  : `NULL AS name`,
    ].join(", ");

    const [rows] = await conn.query(`SELECT ${sel} FROM \`${chosen.table}\``);
    log(`Found ${rows.length} app users.`);

    const withPhone = rows.filter((r) => r.phone).length;
    const withEmail = rows.filter((r) => r.email).length;
    log(`  with a phone: ${withPhone}`);
    log(`  with an email: ${withEmail}`);
    log(`  with neither : ${rows.length - rows.filter((r) => r.phone || r.email).length}  (these can never be matched)`);

    const json = JSON.stringify(rows, null, 2);

    // PowerShell's `>` redirect writes UTF-16 (and Out-File -Encoding utf8 adds
    // a BOM), either of which breaks JSON.parse on the other end. So write the
    // file here in plain UTF-8 and skip the shell entirely.
    const outIdx = process.argv.indexOf("--out");
    const outPath = outIdx > -1 ? process.argv[outIdx + 1] : "app_users.json";
    if (process.argv.includes("--stdout")) {
      process.stdout.write(json);
    } else {
      require("fs").writeFileSync(outPath, json, { encoding: "utf8" });
      log(`\nWritten to ${outPath} (UTF-8, no BOM).`);
      log(`Next:\n  $env:DRY_RUN="1"\n  Get-Content ${outPath} | node script/backfillAppUsers.js --stdin\n`);
    }
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  log("Export failed:", e.message);
  process.exit(1);
});
