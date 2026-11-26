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

// WhatsApp sometimes hands us a hidden "@lid" id instead of her number
// (common for WhatsApp Business senders). Sending to it can fail, so when
// it does and we know her phone, retry to the normal number JID.
async function sendWithLidFallback(sock, person, content) {
  const jid = person.whatsapp_jid;
  const digits = String(person.phone || "").replace(/\D/g, "");
  try {
    return await sock.sendMessage(jid, content);
  } catch (err) {
    if (!/@lid$/.test(jid) || digits.length < 10) throw err;
    console.warn(`⚠️ [WhatsApp] send to ${jid} failed (${err.message}) — retrying ${digits}@s.whatsapp.net`);
    return await sock.sendMessage(`${digits}@s.whatsapp.net`, content);
  }
}

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
      result = await sendWithLidFallback(sock, person, isVideo
        ? { video: { url }, caption: messageBody || "" }
        : { image: { url }, caption: messageBody || "" });
    } else {
      // Plain text
      result = await sendWithLidFallback(sock, person, { text: messageBody });
    }

    const messageId = result?.key?.id || null;
    console.log(`✅ [WhatsApp] Sent to ${person.phone} — msgId: ${messageId}`);

    return { success: true, messageId };
  } catch (err) {
    console.error(`❌ [WhatsApp] Send failed for person ${person.id}:`, err.message);
    return { success: false, error: err.message };
  }
}


// Show / clear "typing…" in her chat while Fiza writes. Cosmetic: never throws,
// returns true if it was shown. Follows the same OUTBOUND_DISABLED rule as
// sending — while sends are blocked, only allow-listed test numbers see it.
async function setTyping(person, on) {
  try {
    if (!person || !person.whatsapp_jid) return false;
    if (process.env.OUTBOUND_DISABLED === "1") {
      const allow = new Set((process.env.OUTBOUND_ALLOWLIST || "").split(",").map((n) => n.replace(/\D/g, "")).filter(Boolean));
      if (!allow.has(String(person.phone || "").replace(/\D/g, ""))) return false;
    }
    const sock = getBaileysClient(person.whatsapp_account_id);
    if (!sock || typeof sock.sendPresenceUpdate !== "function") return false;
    // Presence to a hidden "@lid" id is often dropped — use her number when we have it.
    const digits = String(person.phone || "").replace(/\D/g, "");
    const jid = /@lid$/.test(person.whatsapp_jid) && digits.length >= 10
      ? `${digits}@s.whatsapp.net`
      : person.whatsapp_jid;
    if (on && typeof sock.presenceSubscribe === "function") {
      await sock.presenceSubscribe(jid).catch(() => {});
    }
    await sock.sendPresenceUpdate(on ? "composing" : "paused", jid);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { send, setTyping };
