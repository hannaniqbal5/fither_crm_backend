/**
 * auditList.js — read-only. Audits the Fizza Chats LIST endpoint:
 * checks every column it selects exists, then runs the real queries.
 * Usage: node script/auditList.js
 */
const sequelize = require("../src/config/database");

(async () => {
  try {
    // --- 1. Which columns does the query need from `leads`? ---
    const needLeads = ["id","phone","name","stage","category","lead_score",
      "interaction_status","main_goal","assigned_to","last_message_at",
      "unread_count","merged_into_lead_id","fizza_handled"];
    const [leadCols] = await sequelize.query("SHOW COLUMNS FROM leads");
    const have = leadCols.map(c => c.Field);
    const missing = needLeads.filter(c => !have.includes(c));
    console.log("\n--- leads columns required by the query ---");
    console.log(missing.length ? "❌ MISSING: " + missing.join(", ") : "✅ all present");

    for (const t of ["sales_reps", "messages", "ai_replies"]) {
      try {
        const [c] = await sequelize.query(`SHOW COLUMNS FROM ${t}`);
        console.log(`✅ table ${t}: ${c.map(x => x.Field).join(", ")}`);
      } catch (e) { console.log(`❌ table ${t}: ${e.message}`); }
    }

    const whereClause =
      "WHERE l.merged_into_lead_id IS NULL AND EXISTS (SELECT 1 FROM messages mx WHERE mx.lead_id = l.id)";

    // --- 2. COUNT query ---
    console.log("\n--- COUNT query ---");
    try {
      const [[{ total }]] = await sequelize.query(
        `SELECT COUNT(*) AS total FROM leads l ${whereClause}`, { replacements: {} });
      console.log("✅ total =", total);
    } catch (e) { console.log("❌ COUNT ERROR:", e.message); }

    // --- 3. LIST query (exact) ---
    console.log("\n--- LIST query ---");
    try {
      const [rows] = await sequelize.query(
        `SELECT
           l.id, l.phone, l.name, l.stage, l.lead_score,
           CASE WHEN l.stage = 'user' THEN 'paid' ELSE l.stage END AS category,
           l.interaction_status, l.main_goal, l.assigned_to,
           l.last_message_at, l.unread_count,
           sr.name AS rep_name,
           COALESCE(stats.total_replies, 0) AS total_replies,
           COALESCE(stats.auto_sent, 0)     AS auto_sent,
           COALESCE(stats.last_ai_at, l.last_message_at) AS last_ai_at,
           last_msg.message AS last_message,
           last_msg.direction AS last_direction
         FROM leads l
         LEFT JOIN (
           SELECT ar2.lead_id, COUNT(*) AS total_replies,
                  SUM(CASE WHEN ar2.status = 'sent' THEN 1 ELSE 0 END) AS auto_sent,
                  MAX(ar2.created_at) AS last_ai_at
             FROM ai_replies ar2 GROUP BY ar2.lead_id
         ) stats ON stats.lead_id = l.id
         LEFT JOIN sales_reps sr ON sr.id = l.assigned_to
         LEFT JOIN messages last_msg ON last_msg.id = (
           SELECT m2.id FROM messages m2 WHERE m2.lead_id = l.id ORDER BY m2.id DESC LIMIT 1
         )
         ${whereClause}
         ORDER BY COALESCE(stats.last_ai_at, l.last_message_at) DESC
         LIMIT :limit OFFSET :offset`,
        { replacements: { limit: 50, offset: 0 } }
      );
      console.log(`✅ LIST returned ${rows.length} row(s)`);
      rows.slice(0, 5).forEach(r =>
        console.log(`   id=${r.id} phone=${r.phone} name=${r.name} replies=${r.total_replies} last="${String(r.last_message||"").slice(0,30)}"`));
    } catch (e) { console.log("❌ LIST ERROR:", e.message); }
  } catch (e) {
    console.log("DB error:", e.message);
  } finally { await sequelize.close(); }
})();
