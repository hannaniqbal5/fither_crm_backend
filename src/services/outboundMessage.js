/**
 * outboundMessage.js — ONE place to persist an OUTBOUND message and reset
 * the lead's silence clock.
 *
 * WHY THIS EXISTS
 *   Auto-sent messages (Fiza auto-reply, Layer-5 follow-up, automation rules)
 *   used to go straight out through whatsappChannel.send() WITHOUT being saved
 *   to `messages` or bumping `leads.last_message_at`. Two consequences:
 *     1. The auto-sent message never appeared in the rep's chat history.
 *     2. The follow-up engine (which scans `last_message_at < cutoff`) couldn't
 *        tell the lead had just been contacted — so it could fire a follow-up
 *        ON TOP of a message Fiza had just sent. Double-messaging is exactly
 *        what gets a WhatsApp number flagged/banned.
 *
 *   Routing every auto-send through here fixes both: the message is logged and
 *   last_message_at moves forward, so the next follow-up scan naturally skips a
 *   lead we just contacted, and Fiza + follow-up stop stepping on each other.
 *
 * NOTE: the rep-approve path (ai.routes.js) already inserts its own message row
 *       and bumps last_message_at — do NOT call this from there (double-insert).
 *
 * Mirrors the proven INSERT used by that rep-approve path.
 */

const sequelize = require("../config/database");

/**
 * recordOutbound — persist an OUT message + bump last_message_at (+ optional live socket push).
 *
 * @param {object} person                  People row (needs id; uses assigned_to, whatsapp_account_id)
 * @param {object} opts
 * @param {string} opts.text               message body
 * @param {string} [opts.channel="whatsapp"]
 * @param {string} [opts.externalId]       provider message id (e.g. WhatsApp msg id)
 * @param {number} [opts.repId]            rep to attribute / notify (defaults to person.assigned_to)
 * @param {string} [opts.from="rep"]       sender label (kept to the proven 'rep' value)
 * @param {string} [opts.mediaUrl]         optional media url
 * @param {object} [opts.io]               socket.io server for live chat update
 * @returns {Promise<number|null>} inserted message id
 */
async function recordOutbound(person, {
  text,
  channel = "whatsapp",
  externalId = null,
  repId = null,
  from = "rep",
  mediaUrl = null,
  io = null,
  // Governance: set true for sends WE initiate (campaign / follow-up /
  // automation) so the send gate can track the per-contact proactive budget.
  // Leave false for reactive sends (Fiza reply, rep reply).
  proactive = false,
  source = null,        // 'campaign' | 'followup' | 'automation'
  templateKey = null,
} = {}) {
  if (!person || !person.id) return null;

  const finalRepId  = repId || person.assigned_to || null;
  const waAccountId = channel === "whatsapp" ? (person.whatsapp_account_id || null) : null;
  const messageType = mediaUrl ? "image" : "text";

  // messages.`from` is ENUM('user','rep','bot') and was never extended.
  // Callers pass 'ai' for Fiza, which strict-mode MySQL rejects — so the
  // insert below threw, the auto-reply was never saved, last_message_at never
  // moved, and the follow-up engine messaged her on top of Fiza. The front
  // desk owns this mapping now so no call site can get it wrong again.
  const sender = require("./frontDesk").normalizeSender(from, "OUT");

  // One door (services/frontDesk.js): dedupe on the provider id (so a Baileys
  // echo saved first is corrected, not duplicated), valid sender, silence clock.
  const { message: saved } = await require("./frontDesk").saveMessage({
    contact: person,
    direction: "OUT",
    channel,
    from: sender,
    text: text || "",
    accountId: waAccountId,
    externalMessageId: externalId,
    repId: finalRepId,
    messageType,
    mediaUrl,
    status: "sent",
  });
  const outMessageId = saved.id;

  // Record proactive sends into the gate ledger so the per-contact frequency
  // budget stays accurate across all proactive senders.
  if (proactive) {
    try {
      const { logProactiveSend } = require("./sendGate");
      await logProactiveSend({
        leadId: person.id,
        accountId: waAccountId,
        source,
        templateKey,
      });
    } catch (e) {
      console.error("[recordOutbound] proactive log failed:", e.message);
    }
  }

  // Live-update the rep's chat pane and the admin screens (best-effort).
  if (io) {
    try {
      const target = finalRepId ? io.to(`rep_${finalRepId}`).to("admins") : io.to("admins");
      target.emit("newMessage", {
        id:                  outMessageId,
        lead_id:             person.id,
        rep_id:              finalRepId,
        from: sender,
        channel,
        message:             text,
        direction:           "OUT",
        message_type:        messageType,
        status:              "sent",
        is_read:             1,
        whatsapp_message_id: channel === "whatsapp" ? externalId : null,
        external_message_id: externalId,
        media_url:           mediaUrl,
        created_at:          new Date().toISOString(),
      });
    } catch (e) {
      console.warn(`⚠️  [recordOutbound] socket emit failed: ${e.message}`);
    }
  }

  return outMessageId;
}

module.exports = { recordOutbound };
