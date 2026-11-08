/**
 * welcomeAssets.service.js — Phase 15a.
 *
 * Lookup helpers for the admin-uploaded voice note + poster image used in the
 * first-touch flow (message #2 = voice, message #3 = poster).
 *
 * Activation rule: only ONE asset of (type, language) is active at a time.
 * Admin uploads new version → previous version of same (type, language) auto-deactivates.
 */

const sequelize = require("../config/database");
const fsSync = require("fs");
const path = require("path");

const WELCOME_DIR = path.join(__dirname, "..", "..", "uploads", "welcome");

function ensureUploadDir() {
  if (!fsSync.existsSync(WELCOME_DIR)) {
    fsSync.mkdirSync(WELCOME_DIR, { recursive: true });
  }
  return WELCOME_DIR;
}

/**
 * getActiveAsset — return the active row for a given type + language preference.
 * Falls back to 'both' if specific language not set.
 */
async function getActiveAsset(assetType, language = "ur") {
  try {
    // Try exact language match first
    const [exact] = await sequelize.query(
      `SELECT * FROM welcome_assets
        WHERE asset_type = ? AND language = ? AND is_active = 1
        LIMIT 1`,
      { replacements: [assetType, language] }
    );
    if (exact[0]) return exact[0];

    // Fall back to 'both'
    const [fallback] = await sequelize.query(
      `SELECT * FROM welcome_assets
        WHERE asset_type = ? AND language = 'both' AND is_active = 1
        LIMIT 1`,
      { replacements: [assetType] }
    );
    return fallback[0] || null;
  } catch (err) {
    console.error("[welcomeAssets] getActiveAsset failed:", err.message);
    return null;
  }
}

/**
 * activateAsset — set this asset as active, deactivate previous active of same
 * (type, language). Atomic enough for single-admin scale.
 */
async function activateAsset(id) {
  const [rows] = await sequelize.query(
    "SELECT asset_type, language FROM welcome_assets WHERE id = ?",
    { replacements: [id] }
  );
  if (!rows[0]) throw new Error("Asset not found");
  const { asset_type, language } = rows[0];

  await sequelize.query(
    "UPDATE welcome_assets SET is_active = 0 WHERE asset_type = ? AND language = ? AND is_active = 1",
    { replacements: [asset_type, language] }
  );
  await sequelize.query(
    "UPDATE welcome_assets SET is_active = 1 WHERE id = ?",
    { replacements: [id] }
  );
  return { ok: true };
}

/**
 * logSend — record that we sent this asset to this lead (for analytics).
 */
async function logSend({ asset_id, lead_id, engagement_step, success = true, error_msg = null }) {
  try {
    await sequelize.query(
      `INSERT INTO welcome_asset_sends (asset_id, lead_id, engagement_step, success, error_msg)
       VALUES (?, ?, ?, ?, ?)`,
      { replacements: [asset_id, lead_id, engagement_step, success ? 1 : 0, error_msg] }
    );
  } catch (err) {
    console.error("[welcomeAssets] logSend failed:", err.message);
  }
}

module.exports = {
  WELCOME_DIR,
  ensureUploadDir,
  getActiveAsset,
  activateAsset,
  logSend,
};
