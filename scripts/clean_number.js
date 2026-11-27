/**
 * clean_number.js — wipe a test number's lead(s) and every row that points at
 * them (messages, Fiza replies, campaign_recipients, activities, payment
 * requests, …), so the number can be used fresh in a new campaign.
 *
 *   node scripts/clean_number.js 923034108093
 *
 * Mirrors the admin "Delete this lead" endpoint (adminLeads.routes.js →
 * hardDeleteLead), matching leads by the last 10 digits of the phone.
 */
require('dotenv').config();
const sequelize = require('../src/config/database');

async function hardDeleteLead(id) {
  const [refs] = await sequelize.query(
    `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.IS_NULLABLE AS nullable
       FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = DATABASE()
        AND c.TABLE_NAME <> 'leads'
        AND c.COLUMN_NAME IN ('lead_id','candidate_lead_id')
     UNION
     SELECT k.TABLE_NAME, k.COLUMN_NAME, c.IS_NULLABLE
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.COLUMNS c
         ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME = 'leads'`
  );
  const removed = {};
  await sequelize.transaction(async (transaction) => {
    for (const { t, c, nullable } of refs) {
      if (t === 'leads') {
        await sequelize.query(`UPDATE leads SET \`${c}\` = NULL WHERE \`${c}\` = :id`, { replacements: { id }, transaction });
        continue;
      }
      const [r] = await sequelize.query(
        nullable === 'YES' && c !== 'lead_id'
          ? `UPDATE \`${t}\` SET \`${c}\` = NULL WHERE \`${c}\` = :id`
          : `DELETE FROM \`${t}\` WHERE \`${c}\` = :id`,
        { replacements: { id }, transaction }
      );
      const n = r?.affectedRows ?? 0;
      if (n) removed[`${t}.${c}`] = n;
    }
    const [selfRefs] = await sequelize.query(
      `SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND REFERENCED_TABLE_NAME = 'leads'`,
      { transaction }
    );
    for (const { c } of selfRefs) {
      await sequelize.query(`UPDATE leads SET \`${c}\` = NULL WHERE \`${c}\` = :id`, { replacements: { id }, transaction });
    }
    await sequelize.query('DELETE FROM leads WHERE id = :id', { replacements: { id }, transaction });
  });
  return removed;
}

(async () => {
  const raw = process.argv[2];
  if (!raw) { console.error('Usage: node scripts/clean_number.js <phone>'); process.exit(1); }
  const tail = String(raw).replace(/\D/g, '').slice(-10);
  if (tail.length !== 10) { console.error('Give a phone with at least 10 digits, e.g. 923034108093'); process.exit(1); }

  const [leads] = await sequelize.query(
    "SELECT id, phone, name, subscription_status, app_user_id FROM leads WHERE RIGHT(REGEXP_REPLACE(phone,'[^0-9]',''),10) = :t",
    { replacements: { t: tail } }
  );
  if (!leads.length) { console.log(`No lead found for ...${tail}. Nothing to clean — it's already fresh.`); process.exit(0); }

  for (const l of leads) {
    const stat = String(l.subscription_status || '').toLowerCase();
    if (l.app_user_id) { console.log(`⚠  lead #${l.id} is linked to app account ${l.app_user_id} — deleting the CRM lead anyway (the app account row itself is not touched).`); }
    if (['active','trial','paid'].includes(stat)) { console.log(`⏭  lead #${l.id} has a running plan (${stat}) — skipped.`); continue; }
    const removed = await hardDeleteLead(l.id);
    console.log(`🗑  Deleted lead #${l.id} (${l.phone || 'no phone'}, ${l.name || 'no name'}). Rows removed:`, removed);
  }
  console.log('✅ Done. The number is clean — rebuild the campaign and it will queue and send.');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
