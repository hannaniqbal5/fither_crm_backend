// ⚠️  DESTRUCTIVE: this one-off script DROPS number_batches and number_entries
// (every uploaded number list) before recreating them. It refuses to run
// unless you pass --i-understand-this-deletes-number-uploads.
if (!process.argv.includes("--i-understand-this-deletes-number-uploads")) {
  console.error("Refusing to run: this script DROPS number_batches and number_entries.");
  console.error("Use migrations/037_number_batches.sql through script/runMigration.js instead.");
  process.exit(1);
}
const db = require('./src/config/database');

(async () => {
  await db.query('DROP TABLE IF EXISTS number_entries');
  await db.query('DROP TABLE IF EXISTS number_batches');

  await db.query(`
    CREATE TABLE number_batches (
      id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(200) NOT NULL,
      category ENUM('paid','unpaid') NOT NULL DEFAULT 'unpaid',
      original_file VARCHAR(300) NULL,
      total_numbers INT NOT NULL DEFAULT 0,
      paid_count INT NOT NULL DEFAULT 0,
      unpaid_count INT NOT NULL DEFAULT 0,
      notes TEXT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('number_batches created');

  await db.query(`
    CREATE TABLE number_entries (
      id BIGINT NOT NULL AUTO_INCREMENT,
      batch_id INT NOT NULL,
      phone VARCHAR(30) NOT NULL,
      phone_last10 VARCHAR(10) NOT NULL,
      name VARCHAR(150) NULL,
      category ENUM('paid','unpaid') NOT NULL DEFAULT 'unpaid',
      extra_data JSON NULL,
      notes VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_ne_batch (batch_id),
      INDEX idx_ne_phone (phone_last10),
      INDEX idx_ne_category (category),
      CONSTRAINT fk_ne_batch FOREIGN KEY (batch_id) REFERENCES number_batches(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('number_entries created');
  console.log('Migration done!');
  process.exit();
})().catch(e => { console.error(e.message); process.exit(1); });
