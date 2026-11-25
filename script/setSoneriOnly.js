/**
 * setSoneriOnly.js — make the Soneri account the ONLY active PK payment account.
 * Shows what's there, deactivates the rest, then upserts Soneri.
 * Usage:  node script/setSoneriOnly.js          (dry run — shows current)
 *         node script/setSoneriOnly.js apply    (makes the change)
 */
const sequelize = require("../src/config/database");

const ACC = {
  country_code:   "PK",
  account_type:   "BANK",
  bank_name:      "Soneri Bank",
  account_holder: "Fit Her Private Ltd.",
  account_number: "PK60SONE0000120014636405",
  instructions:   "Transfer karne ke baad screenshot yahan bhej dein.",
};

(async () => {
  const apply = (process.argv[2] || "").toLowerCase() === "apply";
  try {
    const [cols] = await sequelize.query("SHOW COLUMNS FROM payment_accounts");
    const have = cols.map(c => c.Field);
    console.log("\npayment_accounts columns:", have.join(", "));

    const [before] = await sequelize.query(
      "SELECT id, country_code, account_type, bank_name, account_holder, account_number, is_active, display_order FROM payment_accounts ORDER BY country_code, display_order, id");
    console.log("\n--- current accounts ---");
    before.forEach(r => console.log(`  id=${r.id} [${r.country_code}] ${r.account_type} ${r.bank_name} | ${r.account_holder} | ${r.account_number} | active=${r.is_active} order=${r.display_order}`));
    if (!before.length) console.log("  (none)");

    if (!apply) { console.log("\nDry run. Re-run with:  node script/setSoneriOnly.js apply"); return; }

    await sequelize.query("UPDATE payment_accounts SET is_active = 0 WHERE country_code = :c",
      { replacements: { c: ACC.country_code } });

    const [[existing]] = await sequelize.query(
      "SELECT id FROM payment_accounts WHERE account_number = :n LIMIT 1",
      { replacements: { n: ACC.account_number } });

    if (existing) {
      await sequelize.query(
        `UPDATE payment_accounts SET country_code=:country_code, account_type=:account_type,
           bank_name=:bank_name, account_holder=:account_holder, instructions=:instructions,
           is_active=1, display_order=1 WHERE id=:id`,
        { replacements: { ...ACC, id: existing.id } });
      console.log(`\n✅ Updated existing account id=${existing.id} and made it the only active PK account.`);
    } else {
      await sequelize.query(
        `INSERT INTO payment_accounts
           (country_code, account_type, bank_name, account_holder, account_number, instructions, is_active, display_order)
         VALUES (:country_code, :account_type, :bank_name, :account_holder, :account_number, :instructions, 1, 1)`,
        { replacements: ACC });
      console.log("\n✅ Inserted Soneri account as the only active PK account.");
    }

    const [after] = await sequelize.query(
      "SELECT id, country_code, bank_name, account_holder, account_number, is_active FROM payment_accounts WHERE country_code='PK' ORDER BY display_order, id");
    console.log("\n--- PK accounts now ---");
    after.forEach(r => console.log(`  id=${r.id} ${r.bank_name} | ${r.account_holder} | ${r.account_number} | active=${r.is_active}`));
  } catch (e) {
    console.log("Error:", e.message);
  } finally { await sequelize.close(); }
})();
