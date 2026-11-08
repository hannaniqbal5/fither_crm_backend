/**
 * facebookChannel.js — outbound adapter for Facebook Messenger DMs.
 *
 * Used by channelRouter when person.source === 'facebook'.
 * Same Graph API as Instagram — different identity column on the lead.
 */

const sequelize = require("../config/database");
const { sendTextMessage, sendImageMessage } = require("../meta/graphClient");

async function getPageToken(metaPageId) {
  if (metaPageId) {
    const [rows] = await sequelize.query(
      `SELECT page_access_token FROM meta_pages WHERE id = :id AND status = 'active' LIMIT 1`,
      { replacements: { id: metaPageId } }
    );
    if (rows[0]) return rows[0].page_access_token;
  }

  const [fallback] = await sequelize.query(
    `SELECT page_access_token FROM meta_pages WHERE status = 'active' LIMIT 1`
  );
  return fallback[0]?.page_access_token || null;
}

async function send(person, messageBody, mediaUrl = null) {
  try {
    if (!person.facebook_psid) {
      return { success: false, error: "Person has no Facebook PSID" };
    }

    const token = await getPageToken(person.meta_page_id);
    if (!token) {
      return { success: false, error: "No active Meta page configured" };
    }

    let result;
    if (mediaUrl) {
      const url = mediaUrl.startsWith("http")
        ? mediaUrl
        : `${process.env.BASE_URL || "http://localhost:4000"}${mediaUrl}`;
      result = await sendImageMessage(token, person.facebook_psid, url);
      if (messageBody) {
        await sendTextMessage(token, person.facebook_psid, messageBody);
      }
    } else {
      result = await sendTextMessage(token, person.facebook_psid, messageBody);
    }

    const messageId = result?.message_id || null;

    await sequelize.query(
      `INSERT INTO messages (
         lead_id, rep_id, whatsapp_account_id,
         \`from\`, channel, external_message_id, external_thread_id,
         message, direction, message_type, status, is_read, created_at
       ) VALUES (
         :leadId, NULL, NULL,
         'rep', 'facebook', :mid, :tid,
         :text, 'OUT', 'text', 'sent', 1, NOW()
       )`,
      {
        replacements: {
          leadId: person.id,
          mid: messageId,
          tid: person.facebook_psid,
          text: messageBody,
        },
      }
    );

    console.log(`✅ [Facebook] Sent to PSID ${person.facebook_psid} — msgId: ${messageId}`);
    return { success: true, messageId };
  } catch (err) {
    console.error(`❌ [Facebook] Send failed for person ${person.id}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { send };
