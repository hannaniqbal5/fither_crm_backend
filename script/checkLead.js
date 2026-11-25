/**
 * checkLead.js — read-only diagnostic.
 * Usage:  node script/checkLead.js 923034108093
 * Prints whether a lead with that number exists, its stored phone format,
 * whether it's merged away, and if it has any WhatsApp messages.
 */
const sequelize = require("../src/config/database");

(async () => {
  const raw = process.argv[2] || "";
  const digits = String(raw).replace(/[^0-9]/g, "");
  if (!digits) { console.log("Pass a number, e.g. node script/checkLead.js 923034108093"); process.exit(1); }
  const last10 = digits.slice(-10);

  const clean = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(',''),')','')";
  try {
    const [rows] = await sequelize.query(
      `SELECT id, phone, name, merged_into_lead_id,
              (SELECT COUNT(*) FROM messages m WHERE m.lead_id = leads.id) AS msg_count
         FROM leads
        WHERE ${clean} LIKE :a OR ${clean} LIKE :b
        LIMIT 20`,
      { replacements: { a: `%${digits}%`, b: `%${last10}%` } }
    );

    const [[{ total }]] = await sequelize.query("SELECT COUNT(*) AS total FROM leads");
    console.log(`\nTotal leads in DB: ${total}`);
    console.log(`Searching for digits: ${digits}  (national part: ${last10})\n`);

    if (!rows.length) {
      console.log("❌ No lead found with that number. It isn't in the leads table (in any format).");
    } else {
      console.log(`✅ Found ${rows.length} matching lead(s):`);
      rows.forEach(r => {
        console.log(`  id=${r.id} | phone="${r.phone}" | name="${r.name}" | merged_into=${r.merged_into_lead_id} | messages=${r.msg_count}`);
      });
      console.log("\n(If merged_into is NOT null, that lead is hidden as a merged duplicate.)");
    }
  } catch (e) {
    console.log("DB error:", e.message);
  } finally {
    await sequelize.close();
  }
})();
