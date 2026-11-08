/**
 * One-off runner for migration 004 (send gate).
 *
 * Creates proactive_send_log + seeds gate settings, reusing the app's own
 * Sequelize connection (no mysql CLI needed).
 *
 *   node scripts/runMigration004.js
 *
 * Safe to run more than once.
 */

const sequelize = require("../src/config/database");

(async () => {
  try {
    await sequelize.authenticate();

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS proactive_send_log (
        id                  BIGINT       NOT NULL AUTO_INCREMENT,
        lead_id             BIGINT       NOT NULL,
        whatsapp_account_id INT          NULL,
        source              VARCHAR(40)  NOT NULL,
        template_key        VARCHAR(120) NULL,
        created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_psl_lead    (lead_id, created_at),
        KEY idx_psl_account (whatsapp_account_id, created_at)
      )
    `);
    console.log("✅ proactive_send_log ready.");

    await sequelize.query(`
      INSERT IGNORE INTO layer_system_settings (setting_key, setting_value) VALUES
        ('gate_mode',                      'monitor'),
        ('proactive_max_per_contact_day',  '1'),
        ('proactive_max_per_contact_7d',   '3'),
        ('proactive_min_gap_hours',        '24'),
        ('proactive_stop_after_no_reply',  '2'),
        ('proactive_quiet_start',          '9'),
        ('proactive_quiet_end',            '21'),
        ('number_total_daily_softcap',     '800')
    `);
    console.log("✅ Gate settings seeded (gate_mode = monitor).");
    console.log("   → Watch the logs for '[sendGate] MONITOR — would block ...', then");
    console.log("     set gate_mode = 'enforce' in layer_system_settings when ready.");
  } catch (err) {
    console.error("❌ Migration 004 failed:", err.message);
    process.exitCode = 1;
  } finally {
    try { await sequelize.close(); } catch {}
  }
})();
