/**
 * firebase.js — Firebase Admin SDK initializer.
 *
 * Loads service-account credentials from (in priority order):
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON  — full JSON as a single env-var string
 *   2. FIREBASE_SERVICE_ACCOUNT_PATH  — absolute path to JSON file outside repo
 *   3. (DEPRECATED fallback) hardcoded path inside src/config/ — only used if
 *      neither env var is set. Triggers a loud warning. Move to env var ASAP.
 *
 * The service-account JSON is a credential. NEVER commit it to git.
 * .gitignore already excludes src/config/crm-fit-her-firebase-adminsdk-*.json
 * but if the file was committed in an earlier commit, ROTATE the key:
 *   https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk
 */

const admin = require("firebase-admin");
const fs    = require("fs");
const path  = require("path");

function loadServiceAccount() {
  // Option 1: full JSON in env var
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      console.error("❌ FIREBASE_SERVICE_ACCOUNT_JSON is set but not valid JSON:", err.message);
      process.exit(1);
    }
  }

  // Option 2: absolute path in env var (file lives OUTSIDE the repo)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (!fs.existsSync(p)) {
      console.error(`❌ FIREBASE_SERVICE_ACCOUNT_PATH points to a missing file: ${p}`);
      process.exit(1);
    }
    return require(p);
  }

  // Option 3: legacy fallback — find any `crm-fit-her-firebase-adminsdk-*.json` next to this file
  const dir = __dirname;
  const legacy = fs.readdirSync(dir).find((f) =>
    /^crm-fit-her-firebase-adminsdk.*\.json$/.test(f)
  );

  if (legacy) {
    console.warn(
      "⚠️  Firebase service account loaded from hardcoded path. " +
      "This is a security risk — move to FIREBASE_SERVICE_ACCOUNT_JSON env var ASAP and rotate the key."
    );
    return require(path.join(dir, legacy));
  }

  console.error(
    "❌ No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH in .env"
  );
  process.exit(1);
}

const serviceAccount = loadServiceAccount();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

module.exports = admin;
