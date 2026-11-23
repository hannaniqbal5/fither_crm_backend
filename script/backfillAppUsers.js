#!/usr/bin/env node
/**
 * backfillAppUsers.js — one-time script to link existing app users to CRM leads.
 *
 * Run BEFORE go-live so that women who already have app accounts get their
 * app_user_id set on the CRM lead. Matches by phone first, then email.
 *
 * Usage:
 *   DRY_RUN=1 node script/backfillAppUsers.js   (preview, no changes)
 *   node script/backfillAppUsers.js               (apply changes)
 *
 * Requires: PARTNER_BACKEND_URL in .env (default http://localhost:9000)
 *           Partner backend must be running (it reads from partner DB).
 *
 * What it does:
 *   1. Calls partner_backend GET /admin/all-users (paginated)
 *   2. For each app user, tries to match a CRM lead by phone → email
 *   3. Sets app_user_id on the matched lead (skips if already set)
 *   4. Logs every match and skip for audit
 */

require("dotenv").config();
const sequelize = require("../src/config/database");

const PARTNER_URL = process.env.PARTNER_BACKEND_URL || "http://localhost:9000";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

function normalizePhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/[\s+\-()]/g, "");
  // Pakistan: 03xx → 923xx
  if (digits.startsWith("03") && digits.length === 11) {
    digits = "92" + digits.slice(1);
  }
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

async function fetchAppUsers() {
  // Try the admin endpoint on partner_backend
  // If that doesn't exist, fall back to direct DB query description
  try {
    const resp = await fetch(`${PARTNER_URL}/admin/all-users?limit=5000`, {
      headers: { "Content-Type": "application/json" },
    });
    if (resp.ok) {
      const data = await resp.json();
      return data.data || data.users || data;
    }
  } catch (e) {
    console.log("Partner backend not reachable, trying direct query instructions...");
  }

  console.log("\n=== MANUAL MODE ===");
  console.log("Partner backend not available. Export app users as JSON and pipe in:");
  console.log('  cat app_users.json | node script/backfillAppUsers.js --stdin');
  console.log("\nExpected format: [{id, phone, email, name}, ...]");
  console.log("Where id = Firebase UID / app user id\n");
  process.exit(1);
}

async function run() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Backfill App Users → CRM Leads`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE"}`);
  console.log(`${"=".repeat(60)}\n`);

  await sequelize.authenticate();
  console.log("DB connected.\n");

  // If --stdin, read from stdin
  let appUsers;
  if (process.argv.includes("--stdin")) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    appUsers = JSON.parse(Buffer.concat(chunks).toString());
  } else {
    appUsers = await fetchAppUsers();
  }

  if (!Array.isArray(appUsers) || appUsers.length === 0) {
    console.log("No app users found. Nothing to do.");
    process.exit(0);
  }

  console.log(`Found ${appUsers.length} app users to process.\n`);

  let matched = 0, skipped = 0, alreadyLinked = 0, noMatch = 0;

  for (const user of appUsers) {
    const appUserId = String(user.id || user.uid || user.app_user_id || "");
    if (!appUserId) { skipped++; continue; }

    // Already linked?
    const [existing] = await sequelize.query(
      "SELECT id FROM leads WHERE app_user_id = :a AND merged_into_lead_id IS NULL LIMIT 1",
      { replacements: { a: appUserId } }
    );
    if (existing[0]) {
      alreadyLinked++;
      continue;
    }

    // Try phone match
    const phone = normalizePhone(user.phone || user.phoneNumber);
    let leadId = null;

    if (phone) {
      const [rows] = await sequelize.query(
        `SELECT id FROM leads
          WHERE (phone = :phone OR REPLACE(REPLACE(phone, ' ', ''), '+', '') = :phone)
            AND merged_into_lead_id IS NULL
            AND app_user_id IS NULL
          ORDER BY last_message_at DESC, id ASC
          LIMIT 1`,
        { replacements: { phone } }
      );
      if (rows[0]) leadId = rows[0].id;
    }

    // Try email match
    if (!leadId && user.email) {
      const [rows] = await sequelize.query(
        `SELECT id FROM leads
          WHERE email = :email
            AND merged_into_lead_id IS NULL
            AND app_user_id IS NULL
          LIMIT 1`,
        { replacements: { email: user.email } }
      );
      if (rows[0]) leadId = rows[0].id;
    }

    if (!leadId) {
      noMatch++;
      continue;
    }

    console.log(`  MATCH: app_user ${appUserId} → lead #${leadId} (by ${phone ? "phone" : "email"})`);

    if (!DRY_RUN) {
      await sequelize.query(
        "UPDATE leads SET app_user_id = :a, app_synced_at = NOW() WHERE id = :id",
        { replacements: { a: appUserId, id: leadId } }
      );
    }
    matched++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Results:`);
  console.log(`    Matched & linked : ${matched}`);
  console.log(`    Already linked   : ${alreadyLinked}`);
  console.log(`    No CRM match     : ${noMatch}`);
  console.log(`    Skipped (no id)  : ${skipped}`);
  console.log(`    Total processed  : ${appUsers.length}`);
  if (DRY_RUN) console.log(`\n    ⚠ DRY RUN — no changes were made. Run without DRY_RUN=1 to apply.`);
  console.log(`${"=".repeat(60)}\n`);

  await sequelize.close();
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
