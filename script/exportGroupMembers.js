/**
 * exportGroupMembers.js
 *
 * Connects to WhatsApp via existing Baileys session (account 1),
 * finds the group "March Fither(sania2k25)", extracts all members,
 * resolves phone numbers where possible, and saves ALL members to CSV.
 *
 * Members with unresolved LIDs are saved with phone=null — their phone
 * will auto-fill when they message the business number (via remoteJidAlt).
 *
 * Usage: node script/exportGroupMembers.js
 */

const fs = require("fs");
const path = require("path");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  Browsers,
} = require("@whiskeysockets/baileys");

const ACCOUNT_ID = 1;
const SESSION_DIR = path.resolve(__dirname, `../baileys_sessions/${ACCOUNT_ID}`);
const OUTPUT_DIR = path.resolve(__dirname, "../exports");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "group_members.csv");
const TARGET_GROUP = "March Fither(sania2k25)";

/**
 * Try to resolve a LID → phone from the session key files on disk
 */
function resolveFromSessionFiles(lidUser) {
  const reverseFile = path.join(SESSION_DIR, `lid-mapping-${lidUser}_reverse.json`);
  if (fs.existsSync(reverseFile)) {
    try {
      const content = JSON.parse(fs.readFileSync(reverseFile, "utf-8"));
      if (typeof content === "string") return content;
    } catch {}
  }

  // Also check forward mappings (phone → lid) and reverse them
  const sessionFiles = fs.readdirSync(SESSION_DIR);
  for (const file of sessionFiles) {
    const fwdMatch = file.match(/^lid-mapping-(\d+)\.json$/);
    if (fwdMatch) {
      try {
        const storedLid = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, file), "utf-8"));
        if (typeof storedLid === "string" && storedLid === lidUser) {
          return fwdMatch[1]; // the phone number
        }
      } catch {}
    }
  }

  return null;
}

async function main() {
  // Ensure exports directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log(`📱 Connecting to WhatsApp (session: ${SESSION_DIR})...`);

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  let version;
  try {
    const versionInfo = await fetchLatestBaileysVersion();
    version = versionInfo.version;
    console.log(`📌 Using WA Web version: ${version}`);
  } catch (err) {
    console.warn("⚠️ Could not fetch latest version, using default");
  }

  const sockConfig = {
    logger: pino({ level: "silent" }),
    auth: state,
    browser: Browsers.ubuntu("FitHer CRM"),
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
  };

  if (version) sockConfig.version = version;

  const sock = makeWASocket(sockConfig);
  sock.ev.on("creds.update", saveCreds);

  // Wait for connection
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Connection timeout (60s)")), 60000);
    sock.ev.on("connection.update", (update) => {
      if (update.connection === "open") {
        clearTimeout(timeout);
        console.log("✅ WhatsApp connected");
        resolve();
      }
      if (update.connection === "close") {
        clearTimeout(timeout);
        reject(new Error("Connection closed: " + JSON.stringify(update.lastDisconnect?.error)));
      }
    });
  });

  // Fetch group
  console.log(`🔍 Searching for group: "${TARGET_GROUP}"...`);
  const groups = await sock.groupFetchAllParticipating();
  const groupEntries = Object.values(groups);

  const targetGroup = groupEntries.find((g) =>
    g.subject.toLowerCase().includes(TARGET_GROUP.toLowerCase())
  );

  if (!targetGroup) {
    console.error(`❌ Group "${TARGET_GROUP}" not found. Available groups:`);
    groupEntries.forEach((g) => console.log(`  - ${g.subject} (${g.id})`));
    sock.end();
    process.exit(1);
  }

  console.log(`✅ Found group: "${targetGroup.subject}" (${targetGroup.id})`);
  console.log(`👥 Members: ${targetGroup.participants.length}\n`);

  // Extract all members — resolve phone where possible
  const members = [];
  let resolved = 0;
  let unresolved = 0;

  for (const participant of targetGroup.participants) {
    const jid = jidNormalizedUser(participant.id);
    let phone = "";

    if (jid.endsWith("@s.whatsapp.net")) {
      phone = jid.replace("@s.whatsapp.net", "").split(":")[0];
      resolved++;
    } else if (jid.endsWith("@lid")) {
      const lidUser = jid.replace("@lid", "").split(":")[0];
      const resolvedPhone = resolveFromSessionFiles(lidUser);

      if (resolvedPhone) {
        phone = resolvedPhone;
        console.log(`  ✅ ${jid} → ${phone}`);
        resolved++;
      } else {
        console.log(`  ⏳ ${jid} → phone pending (will resolve when they message)`);
        unresolved++;
      }
    }

    members.push({
      phone,
      name: participant.notify || participant.name || "",
      admin: participant.admin || "regular",
      jid,
    });
  }

  // Write CSV with ALL members
  const csvHeader = "phone,name,admin,jid";
  const csvRows = members.map((m) =>
    `${m.phone},"${(m.name || "").replace(/"/g, '""')}",${m.admin},${m.jid}`
  );
  const csvContent = [csvHeader, ...csvRows].join("\n");

  fs.writeFileSync(OUTPUT_FILE, csvContent, "utf-8");

  console.log(`\n========== EXPORT COMPLETE ==========`);
  console.log(`  ✅ Phone resolved: ${resolved}`);
  console.log(`  ⏳ Phone pending:  ${unresolved} (will auto-fill when they message)`);
  console.log(`  📊 Total:          ${members.length}`);
  console.log(`  📁 Saved to:       ${OUTPUT_FILE}`);

  sock.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Export failed:", err.message);
  process.exit(1);
});
