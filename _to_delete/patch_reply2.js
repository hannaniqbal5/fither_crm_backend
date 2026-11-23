const fs=require("fs");const p="src/ai/reply.service.js";let s=fs.readFileSync(p,"utf8");
const a=`    return !!(last && Date.now() - new Date(last.created_at).getTime() < 12 * 60 * 60 * 1000);`;
const b=`    if (last && Date.now() - new Date(last.created_at).getTime() < 12 * 60 * 60 * 1000) return true;
    // Copilot mode: Fiza's earlier draft may still be waiting for the rep — still the same chat.
    const [rows] = await sequelize.query(
      "SELECT 1 FROM ai_replies WHERE lead_id = ? AND status <> 'failed' AND created_at > (NOW() - INTERVAL 12 HOUR) LIMIT 1",
      { replacements: [personId] }
    );
    return rows.length > 0;`;
if(!s.includes(a)) throw "nf"; s=s.replace(a,b); fs.writeFileSync(p,s); console.log("ok");
