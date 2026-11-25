// Creates the monitoring tables if migration 041 hasn't run yet (once per
// process). Keeps deploy order irrelevant.
const fs = require("fs");
const path = require("path");
let ready = null;
function ensureTables(sequelize) {
  if (!ready) {
    const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "041_monitoring.sql"), "utf8");
    const statements = sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    ready = (async () => { for (const st of statements) await sequelize.query(st); })()
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}
module.exports = { ensureTables };
