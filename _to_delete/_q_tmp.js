require("dotenv").config();
const mysql=require("mysql2/promise");
(async()=>{const c=await mysql.createConnection({host:process.env.DB_HOST||"localhost",user:process.env.DB_USER,password:process.env.DB_PASSWORD||process.env.DB_PASS||"",database:process.env.DB_NAME,port:process.env.DB_PORT||3306});
const [l]=await c.query("SELECT id,name,phone,whatsapp_jid,assigned_to,whatsapp_account_id,created_at FROM leads WHERE phone LIKE '%3034108093%' OR whatsapp_jid LIKE '%3034108093%'");console.log(l);
const [r]=await c.query("SELECT id,name,email FROM sales_reps WHERE email='ayesha@company.com'");console.log(r);
const [m]=await c.query("SELECT id,lead_id,direction,LEFT(text,40) t,created_at FROM messages ORDER BY id DESC LIMIT 5").catch(e=>[[e.message]]);console.log(m);
await c.end();})().catch(e=>console.log("ERR",e.message));
