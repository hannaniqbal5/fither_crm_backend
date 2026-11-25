/**
 * addFizzaHandled.js — one-time setup. Adds the `fizza_handled` column to leads.
 * Safe to run more than once (ignores "column already exists").
 * Usage: node script/addFizzaHandled.js
 */
const sequelize = require("../src/config/database");

(async () => {
  try {
    await sequelize.query(
      "ALTER TABLE leads ADD COLUMN fizza_handled TINYINT(1) NOT NULL DEFAULT 0"
    );
    console.log("✅ Added column leads.fizza_handled");
  } catch (e) {
    if (e.original && (e.original.errno === 1060 || /Duplicate column/i.test(e.original.sqlMessage || ""))) {
      console.log("ℹ️  Column leads.fizza_handled already exists — nothing to do.");
    } else {
      console.log("❌ Error:", e.message);
    }
  } finally {
    await sequelize.close();
  }
})();
