/**
 * createAdmin.js — create or promote a sales rep to admin role.
 *
 * Usage:
 *   node scripts/createAdmin.js "Shaista Founder" shaista@fither.com YourSecurePassword
 *   node scripts/createAdmin.js "Hannan Founder"  hannan@fither.com  AnotherSecurePassword
 *
 * If the email already exists, this script PROMOTES that account to admin
 * and updates the password (handy when you forget your dev password).
 *
 * Exits 0 on success, 1 on error.
 */

require("dotenv").config();
const bcrypt = require("bcrypt");
const { SalesRep, WhatsAppAccount } = require("../models");
const sequelize = require("../src/config/database");

async function run() {
  const [, , name, email, password] = process.argv;

  if (!name || !email || !password) {
    console.error("\n❌ Missing arguments.");
    console.error('   Usage: node scripts/createAdmin.js "Full Name" email@example.com password\n');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("\n❌ Password must be at least 8 characters.\n");
    process.exit(1);
  }

  try {
    await sequelize.authenticate();

    // Pick the first active WhatsApp account so the admin has a default
    const waAccount = await WhatsAppAccount.findOne({ where: { status: "active" } })
                   || await WhatsAppAccount.findOne();
    if (!waAccount) {
      console.error("❌ No WhatsApp account exists yet. Add one to whatsapp_accounts first.");
      process.exit(1);
    }

    const hash = await bcrypt.hash(password, 10);
    const existing = await SalesRep.findOne({ where: { email } });

    if (existing) {
      await existing.update({
        name,
        password: hash,
        role: "admin",
        status: "active",
      });
      console.log(`\n✅ Existing user PROMOTED to admin:`);
      console.log(`   id:    ${existing.id}`);
      console.log(`   name:  ${existing.name}`);
      console.log(`   email: ${existing.email}`);
      console.log(`   role:  admin`);
    } else {
      const created = await SalesRep.create({
        name,
        email,
        password: hash,
        role: "admin",
        status: "active",
        whatsapp_account_id: waAccount.id,
      });
      console.log(`\n✅ New ADMIN account created:`);
      console.log(`   id:    ${created.id}`);
      console.log(`   name:  ${created.name}`);
      console.log(`   email: ${created.email}`);
      console.log(`   role:  admin`);
      console.log(`   wa_account_id: ${waAccount.id}`);
    }

    console.log(`\n   Login with: ${email} / <the password you just set>\n`);
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Failed to create admin:", err.message);
    process.exit(1);
  }
}

run();
