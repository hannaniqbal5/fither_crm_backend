/**
 * checkChat.js — read-only. Runs the EXACT queries the Fizza chat-detail
 * endpoint uses, so we can see if it errors or returns empty.
 * Usage: node script/checkChat.js 1
 */
const sequelize = require("../src/config/database");

(async () => {
  const leadId = parseInt(process.argv[2] || "1");
  try {
    // 1) raw message count (no joins)
    const [[{ c }]] = await sequelize.query(
      "SELECT COUNT(*) AS c FROM messages WHERE lead_id = :leadId",
      { replacements: { leadId } }
    );
    console.log(`\nRaw messages for lead ${leadId}: ${c}`);

    // 2) the exact detail query (with the ai_replies join)
    try {
      const [rows] = await sequelize.query(
        `SELECT m.id, m.message, m.direction, m.status, m.message_type,
                m.media_url, m.created_at, m.\`from\`,
                ar.confidence, ar.escalate_reason, ar.status AS ai_status,
                ar.mode AS ai_mode, ar.tier AS ai_tier
           FROM messages m
           LEFT JOIN ai_replies ar ON ar.message_id = m.id AND m.direction = 'IN'
          WHERE m.lead_id = :leadId
          ORDER BY m.id ASC
          LIMIT 200`,
        { replacements: { leadId } }
      );
      console.log(`Detail query returned: ${rows.length} rows`);
      if (rows.length) {
        const last = rows[rows.length - 1];
        console.log(`Last message: dir=${last.direction} from=${last.from} text="${String(last.message).slice(0,40)}"`);
      }
    } catch (e) {
      console.log("❌ Detail query ERROR:", e.message);
    }

    // 3) check ai_replies columns actually exist
    try {
      const [cols] = await sequelize.query("SHOW COLUMNS FROM ai_replies");
      console.log("ai_replies columns:", cols.map(c => c.Field).join(", "));
    } catch (e) {
      console.log("❌ ai_replies table error:", e.message);
    }
  } catch (e) {
    console.log("DB error:", e.message);
  } finally {
    await sequelize.close();
  }
})();
