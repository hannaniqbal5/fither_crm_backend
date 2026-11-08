const { People, Message } = require("../../models");

async function saveMessage({
  whatsapp_jid,
  whatsappAccountId,
  repId,
  from,
  direction,
  status,
  whatsappMessageId,
  message = null,
  message_type = "text",
  media_url = null,
  media_mime = null,
  media_size = null,
  duration = null,
  file_name = null,
}) {
  const person = await People.findOne({ where: { whatsapp_jid } });
  if (!person) throw new Error("Person not found for whatsapp_jid: " + whatsapp_jid);

  const finalRepId = direction === "OUT" ? repId : person.assigned_to;

  const msg = await Message.create({
    lead_id: person.id,
    rep_id: finalRepId,
    from,
    message,
    direction,
    message_type,
    whatsapp_account_id: whatsappAccountId,
    media_url,
    media_mime,
    media_size,
    duration,
    file_name,
    whatsapp_message_id: whatsappMessageId,
    status,
  });

  // Keep the conversation's silence clock authoritative: any OUTBOUND message
  // (rep manual reply, media, etc.) resets last_message_at so the follow-up
  // engine won't fire on a conversation a human just answered. Inbound is
  // bumped by the inbound handler, so we only touch OUT here.
  if (direction === "OUT") {
    try {
      await person.update({ last_message_at: new Date() });
    } catch (e) {
      console.error("[saveMessage] last_message_at bump failed:", e.message);
    }
  }

  return { lead: person, message: msg };
}

module.exports = { saveMessage };
