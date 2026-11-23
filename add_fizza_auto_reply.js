/**
 * add_fizza_auto_reply.js — adds fizza_auto_reply column to campaigns table.
 * Run once: node add_fizza_auto_reply.js
 * Safe to re-run (IF NOT EXISTS check).
 */
const db = require('./src/config/database');

(async () => {
  // Check if column already exists
  const [cols] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'campaigns'
       AND COLUMN_NAME = 'fizza_auto_reply'`
  );

  if (cols.length > 0) {
    console.log('✅ fizza_auto_reply column already exists — nothing to do.');
  } else {
    await db.query(
      `ALTER TABLE campaigns
       ADD COLUMN fizza_auto_reply TINYINT(1) NOT NULL DEFAULT 0
       AFTER assigned_rep_id`
    );
    console.log('✅ Added fizza_auto_reply column to campaigns table.');
  }

  process.exit();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
