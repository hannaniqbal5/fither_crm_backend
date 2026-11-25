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
 * Requires: PARTNER_BACKEND_URL and APP_WEBHOOK_SECRET in .env.
 *           The app backend must expose GET /internal/crm/users and verify the
 *           signature (helper/crmSignature.js), same as its other /internal/crm
 *           routes. If it doesn't yet, use --stdin with exported JSON.
 *
 * What it does:
 *   1. Reads the app's users over a SIGNED call, paginated
 *   2. For each app user, tries to match a CRM lead by phone → email
 *   3. Sets app_user_id on the matched lead (skips if already set)
 *   4. Logs every match and skip for audit
 */

require("dotenv").config();
const sequelize = require("../src/config/database");

const PARTNER_URL = process.env.PARTNER_BACKEND_URL || "http://localhost:9000";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

/** Last ten digits — the part that never changes however a number is written. */
function last10(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}


/**
 * bail — exit without leaving the DB pool open.
 *
 * Calling process.exit() while Sequelize still holds connections trips a libuv
 * assertion on Windows ("!(handle->flags & UV_HANDLE_CLOSING)"). Harmless, since
 * the work is already done, but it looks like a crash and would hide a real one.
 */
async function bail(code) {
  try { await sequelize.close(); } catch {}
  process.exit(code);
}

function manualInstructions(reason) {
  console.log("\n=== MANUAL MODE ===");
  if (reason) console.log(`Reason: ${reason}`);
  console.log("Export the app users as JSON and pipe them in instead:");
  console.log("  cat app_users.json | node script/backfillAppUsers.js --stdin");
  console.log("\nExpected format: [{ id, phone, email, name }, ...]");
  console.log("Where id = the app user id (Firebase UID).\n");
}

/**
 * fetchAppUsers — read the app's user list over a SIGNED server-to-server call.
 *
 * This used to be a bare `fetch` to GET /admin/all-users with no authentication
 * at all, while every other CRM-to-app call signs itself. That meant one of two
 * things, both bad: either the endpoint was open, so anyone who knew the URL
 * could download every woman's phone number and email, or it was protected, the
 * call quietly 401'd, and the script fell into manual mode without saying why.
 *
 * It now goes through services/partnerSigned.js — the same HMAC signing the rest
 * of the CRM uses — and calls GET /internal/crm/customers, which partner_backend
 * ALREADY has (routes/internal.js, guarded by helper/crmSignature.js). No new
 * endpoint and no new auth scheme; the existing ones, applied here too.
 *
 * Paginated, because one 5000-row response is a needless spike on a live DB.
 */
/**
 * normalize — partner_backend returns { count, customers: [{ id, phone, email,
 * firstName, lastName, createdAt }] }. The matcher below wants a single `name`.
 */
function normalize(payload) {
  const rows =
    (payload && (payload.customers || payload.users || payload.data)) ||
    (Array.isArray(payload) ? payload : []);
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    id: r.id,
    phone: r.phone || null,
    email: r.email || null,
    name:
      r.name ||
      [r.firstName, r.lastName].filter(Boolean).join(" ").trim() ||
      null,
    createdAt: r.createdAt || null,
  }));
}

async function fetchAppUsers() {
  const { partnerCall } = require("../src/services/partnerSigned");
  const PAGE = Math.min(Number(process.env.BACKFILL_PAGE_SIZE || 500), 1000);

  const all = [];
  const seen = new Set();
  let offset = 0;

  for (;;) {
    const path = `/internal/crm/customers?limit=${PAGE}&offset=${offset}`;
    let data;
    try {
      data = await partnerCall("GET", path);
    } catch (e) {
      // 503 = APP_WEBHOOK_SECRET missing. 502 = app backend down, or the
      // endpoint isn't built yet. Either way, say which and stop — never fall
      // back to an unsigned request.
      console.error(`\n  Signed call to ${path} failed: ${e.message} (status ${e.status || "?"})`);

      // LOCAL TESTING ESCAPE HATCH.
      // The old unsigned GET /admin/all-users is still reachable, but only when
      // you ask for it explicitly AND the app backend is on this machine. That
      // way it is easy while you're testing and impossible to ship: a deployed
      // .env points at a real host, so this branch simply refuses there.
      const localOnly = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
      const base = (process.env.PARTNER_BACKEND_URL || "http://localhost:9000").replace(/\/$/, "");
      if (process.env.ALLOW_UNSIGNED_BACKFILL === "1") {
        if (!localOnly.test(base)) {
          console.error(`\n  ALLOW_UNSIGNED_BACKFILL is set, but ${base} is not localhost — refusing.`);
          console.error("  An unsigned bulk export of every user's phone and email must never leave this machine.");
          manualInstructions("unsigned mode is local-only by design");
          return bail(1);
        }
        console.warn("\n  ⚠️  UNSIGNED LOCAL MODE — calling GET /admin/all-users with no authentication.");
        console.warn("  ⚠️  Fine against your own machine. Never set ALLOW_UNSIGNED_BACKFILL in a deployed .env.\n");
        try {
          const resp = await fetch(`${base}/internal/crm/customers?limit=${PAGE}&offset=${offset}`, {
            headers: { "Content-Type": "application/json" },
          });
          if (resp.ok) {
            const j = await resp.json();
            const b = normalize(j.data || j);
            if (Array.isArray(b) && b.length) {
              all.push(...b);
              console.log(`  fetched ${all.length} app users (unsigned)...`);
              if (b.length < PAGE) return all;
              offset += PAGE;
              continue;
            }
            return all;
          }
          console.error(`  unsigned call also failed: HTTP ${resp.status}`);
        } catch (e2) {
          console.error(`  unsigned call also failed: ${e2.message}`);
        }
      }

      manualInstructions(
        e.status === 503
          ? "APP_WEBHOOK_SECRET is not set in this .env"
          : "the app backend is unreachable, or rejected the signature (403 means the two " +
            "APP_WEBHOOK_SECRET values don't match). For local testing: ALLOW_UNSIGNED_BACKFILL=1, or use --stdin"
      );
      return bail(1);
    }

    const batch = normalize(data);
    if (!batch.length) break;

    // Dedupe by id and stop when a page brings nothing new. That way this works
    // whether or not the server honours limit/offset: an older build that
    // ignores them and returns the whole table just ends the loop after one pass
    // instead of fetching the same rows forever.
    let added = 0;
    for (const u of batch) {
      const key = String(u.id);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(u);
      added++;
    }
    console.log(`  fetched ${all.length} app users...`);

    if (added === 0) break;
    if (batch.length < PAGE) break;
    offset += PAGE;

    if (all.length > 100000) {
      console.warn("  stopping at 100k users — raise the cap deliberately if you really have more");
      break;
    }
  }

  return all;
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
    // Strip a UTF-8 BOM: anything saved by Notepad or PowerShell's Out-File
    // starts with one, and JSON.parse chokes on it with a confusing error.
    appUsers = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, ""));
  } else {
    appUsers = await fetchAppUsers();
  }

  if (!Array.isArray(appUsers) || appUsers.length === 0) {
    console.log("No app users found. Nothing to do.");
    return bail(0);
  }

  console.log(`Found ${appUsers.length} app users to process.\n`);

  let matched = 0, skipped = 0, alreadyLinked = 0, noMatch = 0;
  let byPhone = 0, byEmail = 0, unreachable = 0;

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

    // Try phone match, on the LAST TEN DIGITS.
    //
    // This used to compare the whole normalized string, which quietly missed a
    // lot: the app stores 923001234567 while a CRM lead saved from a pasted
    // number is often 03001234567. Same woman, no match. frontDesk.js matches
    // on the last ten digits for exactly this reason, and the two have to agree
    // or they disagree about who counts as a duplicate.
    const tail = last10(user.phone || user.phoneNumber);
    let leadId = null;
    let matchedBy = null;

    if (tail) {
      const [rows] = await sequelize.query(
        `SELECT id FROM leads
          WHERE RIGHT(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''), 10) = :tail
            AND merged_into_lead_id IS NULL
            AND app_user_id IS NULL
          ORDER BY (assigned_to IS NOT NULL) DESC, last_message_at DESC, id ASC
          LIMIT 1`,
        { replacements: { tail } }
      );
      if (rows[0]) { leadId = rows[0].id; matchedBy = "phone"; }
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
      if (rows[0]) { leadId = rows[0].id; matchedBy = "email"; }
    }

    if (!leadId) {
      // Say WHY it missed, so the dry run is diagnostic instead of just a count.
      if (!tail && !user.email) unreachable++;
      else noMatch++;
      continue;
    }

    if (matchedBy === "phone") byPhone++; else byEmail++;
    console.log(`  MATCH: app_user ${appUserId} → lead #${leadId} (by ${matchedBy})`);

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
  console.log(`    Matched & linked : ${matched}   (${byPhone} by phone, ${byEmail} by email)`);
  console.log(`    Already linked   : ${alreadyLinked}`);
  console.log(`    No CRM match     : ${noMatch}   (has a phone or email, but no lead carries it)`);
  console.log(`    Unreachable      : ${unreachable}   (no phone AND no email — can never match)`);
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
