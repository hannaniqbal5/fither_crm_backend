/**
 * lead.service.js — DEPRECATED. Kept only so an old import doesn't crash.
 *
 * This was one of seven places that created a woman in this database, each
 * with its own idea of what a lead is. Nothing imports it any more, but an
 * unused creator is a trap: the next person who needs "get or create a lead"
 * finds it, uses it, and we're back to seven shapes.
 *
 * So it now delegates to services/frontDesk.js, the one door in. The behaviour
 * you get is the front desk's: she is matched before she is created, she
 * always gets an owner, and she is never silently duplicated.
 *
 * New code should call frontDesk.findOrCreateContact() directly.
 */

const { findOrCreateContact } = require("./frontDesk");

async function getOrCreatePerson({ phone, name, salesRepId, whatsappAccountId, whatsappJid }) {
  console.warn("[lead.service] DEPRECATED — call frontDesk.findOrCreateContact() instead");

  const { contact } = await findOrCreateContact({
    channel:    whatsappJid ? "whatsapp" : "phone",
    identity:   whatsappJid || phone,
    accountId:  whatsappAccountId,
    phone,
    name,
    repId:      salesRepId || null,
    loosePhone: !whatsappJid,
    source:     "whatsapp",
    gate:       "legacy_lead_service",
  });

  return contact;
}

// Keep the old alias so nothing breaks on import.
const getOrCreateLead = getOrCreatePerson;

module.exports = { getOrCreatePerson, getOrCreateLead };
