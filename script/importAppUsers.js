/**
 * importAppUsers.js — one-time: bring app users the CRM has never heard of
 * into the CRM (Nov 2026). Uses the same rules as a live signup:
 *
 *   1. Already linked to a lead          → skipped
 *   2. Phone or email = exactly one lead → linked to that lead (keeps her rep)
 *   3. Otherwise                         → a new lead with a rep by
 *                                           Team → "New leads go to"
 *   Every woman gets a rep: Fiza works WITH the rep, she is never the owner.
 *   Unclear matches become "Possible match" suggestions for the rep, as usual.
 *   Afterwards the plan sync fills in her plan, expiry and stage.
 *
 * Usage (from the CRM folder):
 *   node script/importAppUsers.js --dry-run          preview only, changes nothing
 *   node script/importAppUsers.js                    import
 *   node script/importAppUsers.js --limit=50         first 50 missing users only (try it)
 *
 * Needs PARTNER_BACKEND_URL + the CRM↔app secret in .env (same as plan sync).
 * Safe to run again: anyone already linked is skipped.
 */
require("dotenv").config();
const sequelize = require("../src/config/database");
const { partnerCall } = require("../src/services/partnerSigned");
const { findOrLinkLead, matchByContact } = require("../src/app_integration/handlers");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const LIMIT = parseInt((args.find((a) => a.startsWith("--limit=")) || "").split("=")[1], 10) || Infinity;
const PAGE = 500;

async function main() {
  const report = { app_customers: 0, already_linked: 0, linked_to_existing: 0, new_with_rep: 0, new_no_rep_available: 0, unclear_suggested: 0, errors: 0 };
  const byStatus = {};
  let done = 0;

  for (let offset = 0; done < LIMIT; offset += PAGE) {
    const [cust, subs] = await Promise.all([
      partnerCall("GET", `/internal/crm/customers?limit=${PAGE}&offset=${offset}`),
      partnerCall("GET", `/internal/crm/subscriptions?limit=${PAGE}&offset=${offset}`),
    ]);
    const customers = cust.customers || [];
    if (!customers.length) break;
    const status = new Map((subs.subscriptions || []).map((s) => [String(s.app_user_id), s.status || "none"]));
    const ids = customers.map((c) => String(c.id));
    const [linked] = await sequelize.query(
      "SELECT app_user_id FROM leads WHERE app_user_id IN (:ids) AND merged_into_lead_id IS NULL",
      { replacements: { ids } }
    );
    const has = new Set(linked.map((l) => String(l.app_user_id)));

    for (const c of customers) {
      report.app_customers++;
      if (has.has(String(c.id))) { report.already_linked++; continue; }
      if (done >= LIMIT) break;
      done++;
      const st = status.get(String(c.id)) || "none";
      byStatus[st] = (byStatus[st] || 0) + 1;
      const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || null;
      try {
        if (DRY) {
          const m = await matchByContact({ phone: c.phone, email: c.email });
          if (m.sure && m.autoOn) report.linked_to_existing++;
          else {
            if (m.clues.length) report.unclear_suggested++;
            report.new_with_rep++;
          }
          continue;
        }
        const r = await findOrLinkLead({ app_user_id: c.id, phone: c.phone, email: c.email, name });
        if (!r.created) report.linked_to_existing++;
        else {
          if ((r.possibleMatches || []).length) report.unclear_suggested++;
          r.lead.assigned_to ? report.new_with_rep++ : report.new_no_rep_available++;
        }
      } catch (e) {
        report.errors++;
        console.error(`  app user ${c.id}: ${e.message}`);
      }
    }
    if (customers.length < PAGE) break;
  }

  console.log(`\n${DRY ? "DRY RUN — nothing changed" : "Import finished"} `);
  console.table(report);
  console.log("Missing users by plan status:", byStatus);
  if (!DRY && (report.linked_to_existing || report.new_with_rep || report.new_no_rep_available)) {
    console.log("\nFilling in plans, expiry and stage (plan sync)…");
    const sync = await require("../src/jobs/planSync.job").runPlanSync();
    console.log(`Plan sync: checked ${sync.checked}, fixed ${sync.fixed}, became members ${sync.became_member}`);
  }
}

main()
  .then(() => sequelize.close())
  .catch(async (e) => { console.error("Import failed:", e.message); await sequelize.close().catch(() => {}); process.exitCode = 1; });
