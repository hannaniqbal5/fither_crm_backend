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

  // One door (services/frontDesk.js): dedupe on the WhatsApp id, a valid
  // sender, the silence clock. Callers still get a Sequelize instance back
  // (they .update() / .destroy() / .toJSON() it).
  const { message: saved } = await require("../services/frontDesk").saveMessage({
    contact: person,
    direction,
    channel: "whatsapp",
    from,
    text: message,
    accountId: whatsappAccountId,
    externalMessageId: whatsappMessageId || null,
    repId: direction === "OUT" ? repId : null,
    messageType: message_type,
    mediaUrl: media_url,
    mediaMime: media_mime,
    mediaSize: media_size,
    duration,
    fileName: file_name,
    status,
  });
  const msg = await Message.findByPk(saved.id);

  return { lead: person, message: msg };
}

module.exports = { saveMessage };
