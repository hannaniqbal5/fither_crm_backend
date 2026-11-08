/**
 * debugPartnerUser.js — diagnostic: shows what's in partner_backend.users for a given id or email.
 * Usage:
 *   node scripts/debugPartnerUser.js
 *
 * Requires PARTNER_DB_URL in .env.
 */
require("dotenv").config();
const { Sequelize } = require("sequelize");

async function run() {
  if (!process.env.PARTNER_DB_URL) {
    console.error("PARTNER_DB_URL not set in .env");
    process.exit(1);
  }
  const db = new Sequelize(process.env.PARTNER_DB_URL, { dialect: "mysql", logging: false });
  try {
    await db.authenticate();
    console.log("Connected to partner_backend DB\n");

    console.log("=== Looking up user id=138 ===");
    const [byId] = await db.query("SELECT id, firstName, lastName, email, userType, status, createdAt FROM Users WHERE id = 138");
    console.log(byId.length === 0 ? "  (no row with id=138)" : byId);

    console.log("\n=== Looking up by email='ayesha@company.com' ===");
    const [byEmail] = await db.query("SELECT id, firstName, lastName, email, userType, status, createdAt FROM Users WHERE email = 'ayesha@company.com'");
    console.log(byEmail.length === 0 ? "  (no rows)" : byEmail);

    console.log("\n=== All Customer_Support_Representative users ===");
    const [csr] = await db.query("SELECT id, firstName, lastName, email, userType, status FROM Users WHERE userType = 'Customer_Support_Representative' LIMIT 10");
    console.log(csr.length === 0 ? "  (no Customer_Support_Representative users exist)" : csr);

    console.log("\n=== Total user count ===");
    const [count] = await db.query("SELECT COUNT(*) AS total FROM Users");
    console.log(count[0]);

    await db.close();
    process.exit(0);
  } catch (err) {
    console.error("DB error:", err.message);
    process.exit(1);
  }
}

run();
