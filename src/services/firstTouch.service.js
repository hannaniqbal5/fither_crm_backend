/**
 * firstTouch.service.js — Phase 15c.
 *
 * After Fiza sends her TEXT reply (auto-send OR rep-approved), this service
 * checks where the customer is in the first-touch flow and conditionally
 * fires the next asset (voice note, then poster).
 *
 * Engagement steps (stored on People.engagement_step):
 *   0 — no Fiza reply sent yet (default for new leads)
 *   1 — first Fiza text reply sent (after customer's 1st inbound)
 *   2 — voice note sent  (after customer's 2nd inbound — she engaged)
 *   3 — poster sent      (after customer's 3rd inbound — sustained interest)
 *   4+ — normal flow; first-touch flow complete, no more auto-assets
 *
 * Trigger logic (after any successful outbound text from Fiza):
 *   1. Count direction='IN' messages for this lead
 *   2. If count >= 2 AND engagement_step < 2 → send VOICE note + caption, bump to 2
 *   3. If count >= 3 AND engagement_step < 3 → send POSTER + caption, bump to 3
 *
 * Never blocks the caller — all errors are logged and swallowed.
 */

const sequelize = require("../config/database");
const { getActiveAsset, logSend } = require("./welcomeAssets.service");
const { getBaileysClient } = require("../whatsapp/baileysClient");
const path = require("path");
const fsSync = require("fs");

const WELCOME_DIR = path.join(__dirname, "..", "..", "uploads", "welcome");

async function inboundCount(leadId) {
  try {
    const [rows] = await sequelize.query(
      "SELECT COUNT(*) AS c FROM messages WHERE lead_id = ? AND direction = 'IN'",
      { replacements: [leadId] }
    );
    return Number(rows[0]?.c || 0);
  } catch { return 0; }
}

async function bumpStep(leadId, newStep) {
  try {
    await sequelize.query(
      "UPDATE leads SET engagement_step = ? WHERE id = ?",
      { replacements: [newStep, leadId] }
    );
  } catch (err) {
    console.error("[firstTouch] bumpStep failed:", err.message);
  }
}

/**
 * Send a voice note via Baileys. Uses local file path (ptt=true makes it a true voice note).
 */
async function sendVoice(person, asset) {
  const sock = getBaileysClient(person.whatsapp_account_id);
  if (!sock || !person.whatsapp_jid) {
    return { success: false, error: "wa_not_connected" };
  }
  const localPath = path.join(WELCOME_DIR, asset.file_name);
  if (!fsSync.existsSync(localPath)) {
    return { success: false, error: `file_missing:${asset.file_name}` };
  }
  try {
    const result = await sock.sendMessage(person.whatsapp_jid, {
      audio: fsSync.readFileSync(localPath),
      mimetype: asset.mime_type || "audio/ogg; codecs=opus",
      ptt: true, // true voice note (not music attachment)
    });
    return { success: true, messageId: result?.key?.id || null };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Send a poster image via Baileys.
 */
async function sendPoster(person, asset) {
  const sock = getBaileysClient(person.whatsapp_account_id);
  if (!sock || !person.whatsapp_jid) {
    return { success: false, error: "wa_not_connected" };
  }
  const localPath = path.join(WELCOME_DIR, asset.file_name);
  if (!fsSync.existsSync(localPath)) {
    return { success: false, error: `file_missing:${asset.file_name}` };
  }
  try {
    const result = await sock.sendMessage(person.whatsapp_jid, {
      image: fsSync.readFileSync(localPath),
      caption: asset.caption || "",
    });
    return { success: true, messageId: result?.key?.id || null };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Persist the outbound asset as a Message row so the chat history shows it.
 */
async function recordMessage(person, kind, externalId, caption) {
  try {
    await sequelize.query(
      `INSERT INTO messages
         (lead_id, rep_id, whatsapp_account_id, \`from\`, message, direction,
          message_type, status, is_read, whatsapp_message_id, created_at)
       VALUES (?, NULL, ?, 'system', ?, 'OUT', ?, 'sent', 1, ?, NOW())`,
      {
        replacements: [
          person.id,
          person.whatsapp_account_id,
          caption || `[${kind}]`,
          kind === "voice" ? "audio" : "image",
          externalId,
        ],
      }
    );
  } catch (err) {
    console.error("[firstTouch] recordMessage failed:", err.message);
  }
}

/**
 * Send a Fiza text caption AFTER the voice/poster (so customer sees context).
 */
async function sendCaptionText(person, captionText) {
  if (!captionText) return;
  const sock = getBaileysClient(person.whatsapp_account_id);
  if (!sock || !person.whatsapp_jid) return;
  try {
    await sock.sendMessage(person.whatsapp_jid, { text: captionText });
    await sequelize.query(
      `INSERT INTO messages
         (lead_id, rep_id, whatsapp_account_id, \`from\`, message, direction,
          message_type, status, is_read, created_at)
       VALUES (?, NULL, ?, 'system', ?, 'OUT', 'text', 'sent', 1, NOW())`,
      { replacements: [person.id, person.whatsapp_account_id, captionText] }
    );
  } catch (err) {
    console.error("[firstTouch] caption send failed:", err.message);
  }
}

/**
 * MAIN ENTRY — called after Fiza's text reply is successfully sent.
 *
 * @param {object} person — fresh Sequelize People row
 * @param {object} [io] — socket.io for live dashboard updates
 */
async function maybeFireEngagementAsset(person, io) {
  if (process.env.FIRST_TOUCH_ASSETS_ENABLED === "false") return { fired: null };
  if (!person || !person.id) return { fired: null };
  if (person.source && person.source !== "whatsapp") return { fired: null }; // Phase 15c is WA-only v1
  if (!person.whatsapp_jid) return { fired: null };

  try {
    const step = Number(person.engagement_step || 0);
    const inbounds = await inboundCount(person.id);

    // Map language preference
    const lang = person.language === "en" ? "en" : "ur";

    let kind = null;
    if (inbounds >= 2 && step < 2) kind = "voice";
    else if (inbounds >= 3 && step < 3) kind = "poster";

    if (!kind) return { fired: null };

    const asset = await getActiveAsset(kind, lang);
    if (!asset) {
      console.log(`📭 [firstTouch] No active ${kind} asset (lang=${lang}) — skipping`);
      return { fired: null, reason: "no_active_asset" };
    }

    const sender = kind === "voice" ? sendVoice : sendPoster;
    const result = await sender(person, asset);

    await logSend({
      asset_id: asset.id,
      lead_id: person.id,
      engagement_step: kind === "voice" ? 2 : 3,
      success: result.success,
      error_msg: result.success ? null : (result.error || "").slice(0, 250),
    });

    if (result.success) {
      await recordMessage(person, kind, result.messageId, asset.caption);
      // If asset has a caption AND it's a voice (image already carries caption), send caption separately for voice
      if (kind === "voice" && asset.caption) {
        await sendCaptionText(person, asset.caption);
      }
      await bumpStep(person.id, kind === "voice" ? 2 : 3);
      console.log(`📨 [firstTouch] Sent ${kind} to lead ${person.id} (inbounds=${inbounds})`);
      if (io) io.to("admins").emit("engagementAssetSent", { lead_id: person.id, kind });
      return { fired: kind };
    } else {
      console.error(`❌ [firstTouch] ${kind} send failed for lead ${person.id}: ${result.error}`);
      return { fired: null, error: result.error };
    }
  } catch (err) {
    console.error("[firstTouch] maybeFire suppressed:", err.message);
    return { fired: null, error: err.message };
  }
}

module.exports = { maybeFireEngagementAsset, inboundCount };
