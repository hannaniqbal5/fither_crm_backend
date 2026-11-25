/**
 * whatsappChannel — thin adapter around existing baileysClient.
 *
 * Zero changes to baileysClient.js. This file is just the bridge
 * between the automation engine and Baileys.
 *
 * Interface: send(person, messageBody, mediaUrl)
 *   → { success, messageId, error }
 */

const { getBaileysClient } = require("../whatsapp/baileysClient");

async function send(person, messageBody, mediaUrl = null) {
  try {
    if (!person.whatsapp_jid) {
      return { success: false, error: "Person has no WhatsApp JID" };
    }

    const sock = getBaileysClient(person.whatsapp_account_id);
    if (!sock) {
      return { success: false, error: "WhatsApp client not connected" };
    }

    let result;

    if (mediaUrl) {
      // Send media with caption
      const url = mediaUrl.startsWith("http")
        ? mediaUrl
        : require("../utils/mediaUrl").publicUrl(mediaUrl); // signed 1-hour link to our /uploads

      // Videos must go out as `video`, not `image` (WhatsApp rejects/garbles
      // an .mp4 sent as an image).
      const isVideo = /\.(mp4|m4v|mov|3gp|webm|mkv)(?:[?#]|$)/i.test(url);
      result = await sock.sendMessage(person.whatsapp_jid, isVideo
        ? { video: { url }, caption: messageBody || "" }
        : { image: { url }, caption: messageBody || "" });
    } else {
      // Plain text
      result = await sock.sendMessage(person.whatsapp_jid, {
        text: messageBody,
      });
    }

    const messageId = result?.key?.id || null;
    console.log(`✅ [WhatsApp] Sent to ${person.phone} — msgId: ${messageId}`);

    return { success: true, messageId };
  } catch (err) {
    console.error(`❌ [WhatsApp] Send failed for person ${person.id}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { send };
