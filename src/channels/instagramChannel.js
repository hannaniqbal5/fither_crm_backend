/**
 * instagramChannel.js — outbound adapter for Instagram DMs.
 *
 * Used by channelRouter when person.source === 'instagram'.
 * Looks up the meta_pages row tied to this person, sends via Meta Graph API.
 *
 * Send signature: send(person, messageBody, mediaUrl) → { success, messageId, error }
 */

const sequelize = require("../config/database");
const { sendTextMessage, sendImageMessage } = require("../meta/graphClient");

async function getPageTokenForLead(leadId, metaPageId) {
  if (metaPageId) {
    const [rows] = await sequelize.query(
      `SELECT page_access_token FROM meta_pages WHERE id = :id AND status = 'active' LIMIT 1`,
      { replacements: { id: metaPageId } }
    );
    if (rows[0]) return rows[0].page_access_token;
  }

  // Fallback: any active page (FitHer expected to have just one)
  const [fallback] = await sequelize.query(
    `SELECT page_access_token FROM meta_pages WHERE status = 'active' LIMIT 1`
  );
  return fallback[0]?.page_access_token || null;
}

async function send(person, messageBody, mediaUrl = null) {
  try {
    if (!person.instagram_psid) {
      return { success: false, error: "Person has no Instagram PSID" };
    }

    const token = await getPageTokenForLead(person.id, person.meta_page_id);
    if (!token) {
      return { success: false, error: "No active Meta page configured" };
    }

    let result;
    if (mediaUrl) {
      const url = mediaUrl.startsWith("http")
        ? mediaUrl
        : require("../utils/mediaUrl").publicUrl(mediaUrl); // signed 1-hour link to our /uploads
      result = await sendImageMessage(token, person.instagram_psid, url);
      // Caption as a follow-up text (Meta API doesn't support caption + image in one call for IG)
      if (messageBody) {
        await sendTextMessage(token, person.instagram_psid, messageBody);
      }
    } else {
      result = await sendTextMessage(token, person.instagram_psid, messageBody);
    }

    const messageId = result?.message_id || null;

    // Persist as outbound message in the messages table
    // One door (services/frontDesk.js). Saved as a rep message by default;
    // a caller that knows better (Fiza's reply, a named rep or admin) saves it
    // again with the same id and the front desk corrects the sender.
    await require("../services/frontDesk").saveMessage({
      contact: person, direction: "OUT", channel: "instagram", from: "rep", text: messageBody,
      accountId: null, externalMessageId: messageId, externalThreadId: person.instagram_psid,
    });

    console.log(`✅ [Instagram] Sent to PSID ${person.instagram_psid} — msgId: ${messageId}`);
    return { success: true, messageId };
  } catch (err) {
    console.error(`❌ [Instagram] Send failed for person ${person.id}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { send };
