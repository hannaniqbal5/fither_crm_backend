/**
 * fixPartnerMigrationState.js — repairs SequelizeMeta on partner_backend
 * after a half-applied migration. Marks the already-applied migration
 * as done so subsequent migrations can run.
 *
 * Run from CRM folder. Requires PARTNER_DB_URL in .env.
 */
require("dotenv").config();
const { Sequelize } = require("sequelize");

const PROBLEM_MIGRATION = "20260505000001-create-consultation-flow-tables.js";

async function run() {
  if (!process.env.PARTNER_DB_URL) {
    console.error("PARTNER_DB_URL not set in .env");
    process.exit(1);
  }
  const db = new Sequelize(process.env.PARTNER_DB_URL, { dialect: "mysql", logging: false });
  try {
    await db.authenticate();
    console.log("Connected to partner_backend DB\n");

    // 1. Show what's currently in SequelizeMeta
    const [meta] = await db.query("SELECT name FROM SequelizeMeta ORDER BY name");
    console.log(`SequelizeMeta has ${meta.length} migrations recorded.`);

    // 2. Check if the problem migration is recorded
    const alreadyMarked = meta.find(m => m.name === PROBLEM_MIGRATION);
    if (alreadyMarked) {
      console.log(`✓ "${PROBLEM_MIGRATION}" is already marked as applied`);
    } else {
      console.log(`Marking "${PROBLEM_MIGRATION}" as applied...`);
      await db.query("INSERT INTO SequelizeMeta (name) VALUES (?)", { replacements: [PROBLEM_MIGRATION] });
      console.log(`✓ Marked. SequelizeMeta now has ${meta.length + 1} entries.`);
    }

    // 3. Show last 5 migrations
    const [recent] = await db.query("SELECT name FROM SequelizeMeta ORDER BY name DESC LIMIT 5");
    console.log("\nMost recent SequelizeMeta entries:");
    recent.forEach(r => console.log("  - " + r.name));

    await db.close();
    console.log("\nDone. Now run: npx sequelize-cli db:migrate");
    process.exit(0);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

run();
