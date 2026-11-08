const { People } = require("../../models");

/**
 * Kept for backward compat — internally uses People model.
 */
async function getOrCreatePerson({ phone, name, salesRepId, whatsappAccountId, whatsappJid }) {
  let person = await People.findOne({
    where: whatsappJid ? { whatsapp_jid: whatsappJid } : { phone },
  });

  if (!person) {
    person = await People.create({
      phone,
      name,
      assigned_to: salesRepId,
      whatsapp_account_id: whatsappAccountId,
      whatsapp_jid: whatsappJid || null,
      stage: "visitor",
      last_message_at: new Date(),
      last_activity_at: new Date(),
      source: "whatsapp",
    });
  } else {
    await person.update({ last_message_at: new Date() });
  }

  return person;
}

// Keep old name as alias
const getOrCreateLead = getOrCreatePerson;

module.exports = { getOrCreatePerson, getOrCreateLead };
