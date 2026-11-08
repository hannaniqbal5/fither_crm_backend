/**
 * normalizePhones.dryrun.js — REPORT ONLY. Makes NO changes to the database.
 *
 * Shows which leads.phone values would change if normalized to the canonical
 * WhatsApp form (E.164 digits without '+', e.g. "03001234567" → "923001234567"),
 * and which of those would COLLIDE with another lead on the same WhatsApp
 * account (UNIQUE KEY uq_phone_wa (phone, whatsapp_account_id)) — those need a
 * manual merge before any normalization is applied.
 *
 * Usage:
 *   node scripts/normalizePhones.dryrun.js            # summary + first 200 rows of each list
 *   node scripts/normalizePhones.dryrun.js --all      # print every row
 *   node scripts/normalizePhones.dryrun.js --json     # machine-readable output
 */
require("dotenv").config();
const sequelize = require("../src/config/database");
const { normalizePhoneDigits } = require("../src/services/phoneCountry");

const args = new Set(process.argv.slice(2));
const SHOW_ALL = args.has("--all");
const AS_JSON = args.has("--json");
const LIMIT = SHOW_ALL ? Infinity : 200;

async function run() {
  // Read-only query.
  const [leads] = await sequelize.query(
    `SELECT id, phone, whatsapp_account_id, whatsapp_jid, source, stage, app_user_id
       FROM leads
      WHERE phone IS NOT NULL AND phone <> ''`
  );

  // Current (phone, account) → lead ids, to detect collisions after normalization.
  const byKey = new Map();
  const key = (p, acc) => `${p}|${acc}`;
  for (const l of leads) {
    const k = key(l.phone, l.whatsapp_account_id);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(l.id);
  }

  const changes = [];
  const unparseable = [];
  const targetGroups = new Map(); // normalized key → leads that would end up with it

  for (const l of leads) {
    const norm = normalizePhoneDigits(l.phone);
    if (!norm) {
      unparseable.push({ id: l.id, phone: l.phone });
      continue;
    }
    const tk = key(norm, l.whatsapp_account_id);
    if (!targetGroups.has(tk)) targetGroups.set(tk, []);
    targetGroups.get(tk).push(l);
    if (norm !== l.phone) {
      changes.push({ id: l.id, account: l.whatsapp_account_id, from: l.phone, to: norm, source: l.source });
    }
  }

  // A collision = 2+ distinct leads on one account that share a normalized phone.
  const changedIds = new Set(changes.map((c) => c.id));
  const collisions = [];
  for (const [tk, group] of targetGroups.entries()) {
    if (group.length < 2) continue;
    if (!group.some((l) => changedIds.has(l.id))) continue; // pre-existing dup, unrelated
    const [norm, acc] = tk.split("|");
    collisions.push({
      normalized: norm,
      account: acc,
      leads: group.map((l) => ({ id: l.id, phone: l.phone, source: l.source, stage: l.stage, jid: l.whatsapp_jid, app_user_id: l.app_user_id })),
    });
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ scanned: leads.length, changes, collisions, unparseable }, null, 2));
    return;
  }

  console.log(`Scanned ${leads.length} leads with a phone.`);
  console.log(`  Would change     : ${changes.length}`);
  console.log(`  Would collide    : ${collisions.length} group(s) (need manual merge first)`);
  console.log(`  No digits at all : ${unparseable.length}`);
  console.log("");

  if (changes.length) {
    console.log("── Would change (id | account | current → normalized | source) ──");
    changes.slice(0, LIMIT).forEach((c) =>
      console.log(`  #${c.id} | acc ${c.account} | ${c.from} → ${c.to} | ${c.source}`)
    );
    if (changes.length > LIMIT) console.log(`  … ${changes.length - LIMIT} more (use --all)`);
    console.log("");
  }

  if (collisions.length) {
    console.log("── Would collide on (phone, whatsapp_account_id) ──");
    collisions.slice(0, LIMIT).forEach((g) => {
      console.log(`  ${g.normalized} on account ${g.account}:`);
      g.leads.forEach((l) =>
        console.log(`     lead #${l.id}  phone=${l.phone}  source=${l.source}  stage=${l.stage}  jid=${l.jid || "-"}  app_user=${l.app_user_id || "-"}`)
      );
    });
    if (collisions.length > LIMIT) console.log(`  … ${collisions.length - LIMIT} more (use --all)`);
    console.log("");
  }

  if (unparseable.length) {
    console.log("── Phone has no digits ──");
    unparseable.slice(0, LIMIT).forEach((u) => console.log(`  #${u.id} | ${JSON.stringify(u.phone)}`));
    console.log("");
  }

  console.log("Dry run only — nothing was written.");
}

run()
  .catch((err) => {
    console.error("❌ dry run failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close().catch(() => {}));
