/**
 * linkRepToPartnerBackend.js
 *
 * Migrates a CRM sales rep into partner_backend's user system so they can
 * authenticate via partner_backend and use the CRM with that same JWT.
 *
 * Usage:
 *   node scripts/linkRepToPartnerBackend.js <repEmail>
 *
 * Example:
 *   node scripts/linkRepToPartnerBackend.js ayesha@company.com
 *
 * What it does:
 *   1. Adds `partner_user_id` column to sales_reps if missing
 *   2. Looks up the rep in CRM sales_reps by email
 *   3. Creates / finds matching row in partner_backend.users
 *        (userType = 'Customer_Support_Representative')
 *   4. Sets sales_reps.partner_user_id to link the two
 *
 * Requirements:
 *   - PARTNER_DB_URL set in .env (mysql connection string for partner_backend DB)
 *     e.g. PARTNER_DB_URL=mysql://user:pass@host:3306/partner_backend_db
 *   - If PARTNER_DB_URL is missing, the script falls back to instructions
 *     for adding the user manually.
 */

require("dotenv").config();
const bcrypt = require("bcrypt");
const sequelize = require("../src/config/database");
const { SalesRep } = require("../models");

const [, , emailArg] = process.argv;

async function ensurePartnerUserIdColumn() {
  try {
    await sequelize.query(
      `ALTER TABLE sales_reps ADD COLUMN partner_user_id INT NULL AFTER whatsapp_account_id`
    );
    console.log("  ✓ Added partner_user_id column to sales_reps");
  } catch (err) {
    if (err.message.includes("Duplicate column")) {
      console.log("  ✓ partner_user_id column already exists");
    } else {
      throw err;
    }
  }
}

async function ensureIndex() {
  try {
    await sequelize.query(
      `ALTER TABLE sales_reps ADD INDEX idx_partner_user_id (partner_user_id)`
    );
    console.log("  ✓ Added index on partner_user_id");
  } catch (err) {
    if (err.message.includes("Duplicate key name")) {
      console.log("  ✓ Index already exists");
    } else {
      console.warn("  ! Index creation skipped:", err.message);
    }
  }
}

async function run() {
  console.log("\n  Link CRM rep to partner_backend user\n");

  if (!emailArg) {
    console.error("  ERROR: missing email argument.");
    console.error('  Usage: node scripts/linkRepToPartnerBackend.js <email>\n');
    process.exit(1);
  }

  try {
    await sequelize.authenticate();

    // Step 1: schema
    console.log("  Step 1: schema migration");
    await ensurePartnerUserIdColumn();
    await ensureIndex();

    // Step 2: find the CRM rep
    console.log("\n  Step 2: looking up CRM rep");
    const rep = await SalesRep.findOne({ where: { email: emailArg } });
    if (!rep) {
      console.error(`  ERROR: no CRM sales_reps row with email ${emailArg}`);
      console.error("  Did you mean to run createAdmin.js first?\n");
      process.exit(1);
    }
    console.log(`  ✓ Found rep id=${rep.id} name="${rep.name}"`);

    if (rep.partner_user_id) {
      console.log(`  Rep is already linked to partner_user_id=${rep.partner_user_id}`);
      console.log(`  Nothing more to do.\n`);
      process.exit(0);
    }

    // Step 3: try direct DB connection to partner_backend
    console.log("\n  Step 3: connecting to partner_backend DB");

    if (!process.env.PARTNER_DB_URL) {
      console.log("\n  PARTNER_DB_URL not set in .env — falling back to manual instructions.\n");
      console.log("  Please run this SQL on your partner_backend MySQL database:\n");
      console.log(`  ────────────────────────────────────────────────────────────`);
      console.log(`  -- 1. Create the user (use bcrypt(10) for the password)`);
      console.log(`  --    The password hash below is for 'changeme123' — replace it.`);
      console.log(`  INSERT INTO users`);
      console.log(`    (firstName, lastName, email, password, userType, status, createdAt, updatedAt)`);
      console.log(`  VALUES`);
      console.log(`    (${q(rep.name.split(" ")[0] || rep.name)}, ${q(rep.name.split(" ").slice(1).join(" "))}, ${q(rep.email)},`);
      console.log(`     ${q(await bcrypt.hash("changeme123", 10))},`);
      console.log(`     'Customer_Support_Representative', 1, NOW(), NOW());`);
      console.log(``);
      console.log(`  -- 2. Note the auto-generated id from the INSERT, then run:`);
      console.log(`  UPDATE sales_reps SET partner_user_id = <new_id> WHERE id = ${rep.id};`);
      console.log(`  ────────────────────────────────────────────────────────────\n`);
      console.log(`  After that, tell the rep to log in via partner_backend (/admin/login)`);
      console.log(`  using email '${rep.email}' and password 'changeme123' (change it later).\n`);
      process.exit(0);
    }

    // If we get here, PARTNER_DB_URL is configured — connect and insert directly
    const { Sequelize } = require("sequelize");
    const partnerDb = new Sequelize(process.env.PARTNER_DB_URL, { dialect: "mysql", logging: false });
    await partnerDb.authenticate();
    console.log("  ✓ Connected to partner_backend DB");

    const [existing] = await partnerDb.query(
      `SELECT id, userType FROM users WHERE email = :email LIMIT 1`,
      { replacements: { email: rep.email } }
    );

    let partnerId;
    if (existing.length > 0) {
      const u = existing[0];
      partnerId = u.id;
      console.log(`  ✓ Existing partner_backend user found id=${partnerId} userType="${u.userType}"`);
      if (u.userType !== "Customer_Support_Representative") {
        await partnerDb.query(
          `UPDATE users SET userType = 'Customer_Support_Representative', updatedAt = NOW() WHERE id = :id`,
          { replacements: { id: partnerId } }
        );
        console.log("  ✓ Updated userType to Customer_Support_Representative");
      }
    } else {
      const tempPassword = "changeme123";
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      const [nameFirst, ...nameRest] = (rep.name || "Rep").split(" ");
      const [insertResult] = await partnerDb.query(
        `INSERT INTO users
          (firstName, lastName, email, password, userType, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'Customer_Support_Representative', 1, NOW(), NOW())`,
        { replacements: [nameFirst, nameRest.join(" "), rep.email, passwordHash] }
      );
      partnerId = insertResult.insertId || insertResult;
      console.log(`  ✓ Created partner_backend user id=${partnerId}`);
      console.log(`  ✓ Temporary password set: ${tempPassword}`);
      console.log(`     Tell the rep to log in once, then change it.`);
    }

    await partnerDb.close();

    // Step 4: link CRM rep to partner user
    console.log("\n  Step 4: linking CRM rep to partner_user");
    rep.partner_user_id = partnerId;
    await rep.save();
    console.log(`  ✓ Linked sales_reps.id=${rep.id} → partner_user_id=${partnerId}`);

    console.log("\n  ════════════════════════════════════════════════════════════");
    console.log("  DONE");
    console.log("  ");
    console.log(`  Rep:           ${rep.email}`);
    console.log(`  CRM id:        ${rep.id}`);
    console.log(`  partner_user:  ${partnerId}`);
    console.log(`  Login via:     partner_backend's /admin/login`);
    console.log(`                 userType: 'Customer_Support_Representative'`);
    console.log("  ════════════════════════════════════════════════════════════\n");

    process.exit(0);
  } catch (err) {
    console.error("\n  ERROR:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

function q(s) {
  if (s === null || s === undefined) return "NULL";
  return `'${String(s).replace(/'/g, "''")}'`;
}

run();
