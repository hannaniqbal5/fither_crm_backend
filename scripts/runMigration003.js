/**
 * One-off runner for migration 003 (message_templates.active).
 *
 * Adds the on/off column WITHOUT needing the mysql CLI — it reuses the same
 * Sequelize connection the app uses (src/config/database.js → config.json).
 *
 * Run from the project root:
 *   node scripts/runMigration003.js
 *
 * Safe to run more than once: it checks for the column first.
 */

const sequelize = require("../src/config/database");

(async () => {
  try {
    await sequelize.authenticate();

    const [rows] = await sequelize.query(
      `SELECT COUNT(*) AS c
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'message_templates'
          AND COLUMN_NAME  = 'active'`
    );

    if (Number(rows[0].c) > 0) {
      console.log("✓ message_templates.active already exists — nothing to do.");
    } else {
      await sequelize.query(
        `ALTER TABLE message_templates
           ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1 AFTER media_url`
      );
      console.log("✅ Added column message_templates.active (default 1).");
    }
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    process.exitCode = 1;
  } finally {
    try { await sequelize.close(); } catch {}
  }
})();
