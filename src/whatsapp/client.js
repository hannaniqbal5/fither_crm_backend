// // const { Client, LocalAuth } = require('whatsapp-web.js');
// // const qrcode = require('qrcode-terminal');
// // const path = require('path');
// // const axios = require('axios');
// // const Lead = require('../../models/Lead');
// // const Message = require('../../models/Message');




// // async function saveWhatsAppMessage({ phone, rep_id, direction = "IN", status = "recieved", from, message1, messageType = 'text', mediaUrl = null, whatsappMessageId, io
// // }) {
// //   // Find existing lead
// //   let lead = await Lead.findOne({ where: { phone } });

// //   if (!lead) {
// //     // Lead doesn't exist → create new
// //     lead = await Lead.create({
// //       phone,
// //       status: 'new',
// //       assigned_to: rep_id || null
// //     });
// //     console.log(`📌 Lead created for ${phone} and assigned to Rep ${rep_id}`);
// //   } else {
// //     // Lead exists → optionally update last_message_at and assigned rep
// //     await lead.update({
// //       last_message_at: new Date(),
// //       assigned_to: rep_id || lead.assigned_to
// //     });
// //     console.log(`✅ Lead exists for ${phone}, updated last_message_at and assigned rep`);
// //   }

// //   // Save the message
// //   const message = await Message.create({
// //     lead_id: lead.id,
// //     rep_id: rep_id,
// //     from,
// //     message: message1,
// //     direction,
// //     status,
// //     message_type: messageType,
// //     media_url: mediaUrl,
// //     whatsapp_message_id: whatsappMessageId
// //   });
// //ok



// // io.to(`lead_${lead.id}`).emit("newMessage", message);

// // // 🔔 NOTIFICATION (always)
// // io.to(`rep_${rep_id}`).emit("newWhatsAppMessage", {
// //   leadId: lead.id,
// //   text: message.message
// // });
// // resolve repId safely
// // const finalRepId = rep_id || lead.assigned_to;

// // if (!finalRepId) {
// //   console.warn("⚠️ No rep assigned for lead:", lead.id);
// // }
// // console.log("========== SOCKET TRACE START ==========");
// // console.log("📨 Incoming WhatsApp message");
// // console.log("📌 lead.id:", lead.id);
// // console.log("📌 rep_id (raw):", rep_id);
// // console.log("📌 lead.assigned_to:", lead.assigned_to);
// // console.log("📌 io exists:", !!io);
// // console.log("📡 Emitting newMessage to room:", `lead_${lead.id}`);

// // // 💬 live chat update (open chat)

// // io.to(`lead_${lead.id}`).emit("newMessage", message);
// // console.log("✅ newMessage emit CALLED");

// // // 🔔 notification (closed chat)
// // if (finalRepId) {
// //   io.to(`rep_${finalRepId}`).emit("newWhatsAppMessage", {
// //     leadId: lead.id,
// //     text: message.message
// //   });
// // }


// //   // io.to(`lead_${message.lead_id}`).emit("newMessage", {
// //   //   message: message.message1,
// //   //   direction: "IN"
// //   // });
// //   // io.to(`lead_${lead_id}`).emit("newMessage", message);

// //   // io.to(`${rep_id}`).emit("unreadNotification", {
// //   //   lead_id,
// //   //   preview: message.message
// //   // });
// //   console.log(`💬 Message saved for lead ${phone}`);
// //   return message;


// //k
// // const finalRepId = rep_id || lead.assigned_to;

// // if (!finalRepId) {
// //   console.warn("⚠️ No rep assigned, skipping socket emit");
// //   return message;
// // }

// // /* =========================
// //    SOCKET EMITS (CORRECT)
// // ========================= */
// // console.log("========== SOCKET TRACE ==========");
// // console.log("📌 lead.id:", lead.id);
// // console.log("📌 finalRepId:", finalRepId);
// // console.log("📌 io exists:", !!io);

// // // 🔥 MAIN DELIVERY EVENT (ALWAYS)
// // io.to(`rep_${finalRepId}`).emit("newMessage", message);
// // console.log("📡 newMessage → rep_", finalRepId);

// // // 🔔 OPTIONAL notification event
// // io.to(`rep_${finalRepId}`).emit("newWhatsAppMessage", {
// //   leadId: lead.id,
// //   text: message.message
// // });
// // console.log("🔔 newWhatsAppMessage → rep_", finalRepId);

// // console.log("💬 Message saved & emitted successfully");
// // return message;

// // }



// // function createWhatsAppClient(repId, sessionPath, io) {
// //   const client = new Client({
// //     authStrategy: new LocalAuth({
// //       dataPath: sessionPath
// //     }),
// //     puppeteer: {
// //       executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
// //       headless: false,
// //       args: ['--no-sandbox', '--disable-setuid-sandbox']
// //     }
// //   });

// //   client.on('qr', qr => {
// //     console.log(`📲 Scan QR for Rep ${repId}`);
// //     qrcode.generate(qr, { small: true });
// //   });

// //   client.on('authenticated', () =>
// //     console.log(`🔐 Rep ${repId} authenticated`)
// //   );

// //   client.on('ready', () =>
// //     console.log(`✅ Rep ${repId} WhatsApp ready`)
// //   );

// //   client.on('message', async msg => {
// //     const phone = msg.from.replace('@c.us', '');
// //     const text = msg.body;
// //     function extractPhone(jid) {
// //       if (!jid) return null;

// //       if (jid.endsWith("@c.us")) {
// //         return jid.replace("@c.us", "");
// //       }

// //       return null; // ignore @lid, @g.us, etc
// //     }

// //     try {
// //       // Skip groups & broadcasts
// //       if (msg.from.endsWith('@g.us') || msg.from.endsWith('@broadcast')) return;

// //       const phone = extractPhone(msg.from);

// //       if (!phone) {
// //         console.log("⚠️ Ignoring non-phone WhatsApp ID:", msg.from);
// //         return;
// //       }

// //       console.log(`💬 Rep ${repId} got message from ${phone}: ${text}`);

// //       let lead = await Lead.findOne({ where: { phone } });

// //       if (!lead) {
// //         lead = await Lead.create({
// //           phone,
// //           status: 'new',
// //           assigned_to: repId
// //         });

// //         console.log(`📌 Lead created & assigned to Rep ${repId}`);
// //       }

// //       await lead.update({
// //         last_message_at: new Date(),
// //       });


// //       // ✅ Save the message (for new or existing lead)
// //       return await saveWhatsAppMessage({
// //         phone,
// //         lead_id: lead.id,    // use the actual lead id
// //         rep_id: repId,
// //         from: "User",        // sender         // your number
// //         message1: text,
// //         direction: "IN",
// //         status: "received",
// //         whatsappMessageId: msg.id.id,
// //         io
// //       });

// //     } catch (err) {
// //       console.error('❌ WhatsApp handler error:', err.message);
// //     }


// //   });

// //   client.initialize();
// //   return client;
// // }




// // module.exports = { createWhatsAppClient, saveWhatsAppMessage } // ✅ THIS LINE IS CRITICAL
// // const { Client, LocalAuth } = require("whatsapp-web.js");
// // const qrcode = require("qrcode-terminal");

// // const clients = new Map(); // whatsappAccountId → client

// // function initClient(account) {
// //   if (clients.has(account.id)) {
// //     return clients.get(account.id);
// //   }

// //   const client = new Client({
// //     authStrategy: new LocalAuth({
// //       dataPath: account.session_path
// //     }),
// //     puppeteer: { headless: false }
// //   });

// //   client.on("qr", qr => {
// //     console.log(`📲 Scan QR for WhatsAppAccount ${account.id}`);
// //     qrcode.generate(qr, { small: true });
// //   });

// //   client.on("ready", () => {
// //     console.log(`✅ WhatsAppAccount ${account.id} ready`);
// //   });

// //   client.initialize();
// //   clients.set(account.id, client);

// //   return client;
// // }

// // function getClient(whatsappAccountId) {
// //   return clients.get(whatsappAccountId);
// // }

// // module.exports = { initClient, getClient };
// const { Client, LocalAuth } = require("whatsapp-web.js");
// const qrcode = require("qrcode-terminal");
// const { handleIncomingWhatsAppMessage } = require("./message.handler");
// const { getNextRepRoundRobin } = require("../services/assignment.service");

// const clients = new Map();

// function initClient(account, io) {
//   if (clients.has(account.id)) return clients.get(account.id);

//   const client = new Client({
//     authStrategy: new LocalAuth({
//       dataPath: account.session_path,
//     }),
//     puppeteer: {
//       headless: false,
//       args: ['--no-sandbox', '--disable-setuid-sandbox'],
//     },
//     webVersionCache: {
//       type: 'none'   // 🔥 THIS FIXES WidFactory errors
//     }
//   });
  
//   client.on("qr", (qr) => {
//     console.log(`📲 Scan QR for WhatsAppAccount ${account.id}`);
//     qrcode.generate(qr, { small: true });
//   });

//   client.on("ready", () => {
//     console.log(`✅ WhatsAppAccount ${account.id} ready`);
//   });

// client.on("message", async (msg) => {
//   try {

//     // ❌ Ignore group messages
//     if (msg.from.endsWith("@g.us")) {
//       console.log("🚫 Group message ignored:", msg.from);
//       return;
//     }

//     console.log("========== 📩 WHATSAPP MESSAGE DEBUG ==========");
//     console.log("📞 From:", msg.from);
//     console.log("💬 Body:", msg.body);
//     console.log("🆔 WhatsApp msg id:", msg.id?.id);

//     await handleIncomingWhatsAppMessage({
//       msg,
//       repId: account.rep_id,
//       whatsappAccountId: account.id,
//       io,
//     });

//   } catch (err) {
//     console.error("❌ WhatsApp message handler error:", err);
//   }
// });

//   function getClient(whatsappAccountId) {
//     return clients.get(whatsappAccountId);
//   }
//   client.initialize();
//   clients.set(account.id, client);
//   return client;
// }

// function getClient(whatsappAccountId) {
//   return clients.get(whatsappAccountId);
// }
// module.exports = { initClient, getClient };
