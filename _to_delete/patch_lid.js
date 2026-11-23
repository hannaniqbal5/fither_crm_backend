const fs=require("fs");const p="src/whatsapp/baileysClient.js";let s=fs.readFileSync(p,"utf8");
const old=`      const num = String(jid || "").split("@")[0].split(":")[0];
      if (allow.has(num)) return realSend(jid, ...rest);`;
const neu=`      const num = String(jid || "").split("@")[0].split(":")[0];
      if (allow.has(num)) return realSend(jid, ...rest);
      // Privacy JIDs (@lid) hide the number: check the stored lead phone instead.
      if (allow.size && String(jid).endsWith("@lid")) {
        try {
          const [rows] = await sequelize.query("SELECT phone FROM leads WHERE whatsapp_jid = ? LIMIT 1", { replacements: [jid] });
          const ph = String((rows[0] && rows[0].phone) || "").replace(/\\D/g, "");
          if (ph && allow.has(ph)) return realSend(jid, ...rest);
        } catch (_) { /* fall through to block */ }
      }`;
if(!s.includes(old)) throw "nf"; s=s.replace(old,neu);
s=s.replace("throw new Error(`Outbound messaging is disabled (OUTBOUND_DISABLED=1) for ${jid}; allowlist=${[...allow].length}`);",'throw new Error("Outbound messaging is disabled (OUTBOUND_DISABLED=1)");');
fs.writeFileSync(p,s);console.log("ok");
