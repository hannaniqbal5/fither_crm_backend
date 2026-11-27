/**
 * baileysClient.js — the live WhatsApp connection (Baileys).
 *
 * Four superseded versions of this file used to sit above this line,
 * commented out: 1,476 lines of dead code that shadowed the real thing and
 * made the file easy to edit in the wrong place. Git has every one of them.
 */
const fs = require("fs");
const path = require("path");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  downloadContentFromMessage,
  Browsers,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const qrcode = require("qrcode-terminal");

const { Message, WhatsAppAccount } = require("../../models");
const sequelize = require("../config/database");
const { handleIncomingWhatsAppMessage } = require("./message.handler");

const clients = new Map();
const reconnectAttempts = new Map();   // accountId -> attempt count
const latestQr = new Map();            // accountId -> most recent QR string (for dashboard onboarding)
const connectedAccounts = new Set();   // accountIds whose connection is actually OPEN (not just created)
const intentionalClose = new Set();    // accountIds we deliberately disconnected — do NOT auto-reconnect
const pairingCodes = new Map();        // accountId -> latest 8-char pairing code ("link with number")
const pairingPhones = new Map();       // accountId -> phone (E.164, no +) to pair; presence = code mode
const MAX_RECONNECT_ATTEMPTS = 10;
const SLOW_RETRY_MS = 10 * 60 * 1000;  // after MAX_RECONNECT_ATTEMPTS, keep retrying every 10 min
const inFlightCreates = new Map();     // accountId -> Promise of a socket being set up (prevents double sockets)
const PRINT_QR = process.env.WA_PRINT_QR === "true"; // print QR / pairing codes to the log only when opted in

/**
 * Reconnect after a delay — skipped if the admin has since disconnected the
 * account (intentionalClose / status != active). Never throws.
 */
function scheduleReconnect(accountId, io, delay) {
  setTimeout(async () => {
    try {
      if (intentionalClose.has(accountId)) {
        console.log(`🔌 [Account ${accountId}] Reconnect skipped — manually disconnected.`);
        return;
      }
      const acc = await WhatsAppAccount.findByPk(accountId, { attributes: ["id", "status"] });
      if (!acc || acc.status !== "active") {
        console.log(`🔌 [Account ${accountId}] Reconnect skipped — account is not active.`);
        return;
      }
      await createBaileysClient(accountId, io, { _reconnect: true });
    } catch (err) {
      console.error(`❌ [Account ${accountId}] reconnect failed:`, err?.message || err);
      // Setup itself threw (no socket → no close event to retry from): try again later.
      if (!clients.has(accountId)) scheduleReconnect(accountId, io, SLOW_RETRY_MS);
    }
  }, delay);
}

/* =====================
   MESSAGE PAYLOAD PARSER
===================== */
function extractMessagePayload(msg) {
  const m = msg.message;
  if (!m) return null;

  // TEXT
  if (m.conversation) {
    return {
      message_type: "text",
      text: m.conversation,
    };
  }

  if (m.extendedTextMessage?.text) {
    return {
      message_type: "text",
      text: m.extendedTextMessage.text,
    };
  }

  // IMAGE
  if (m.imageMessage) {
    return {
      message_type: "image",
      text: m.imageMessage.caption || null,
      media: m.imageMessage,
    };
  }

  // VIDEO
  if (m.videoMessage) {
    return {
      message_type: "video",
      text: m.videoMessage.caption || null,
      media: m.videoMessage,
      duration: m.videoMessage.seconds || null,
    };
  }

  // AUDIO / VOICE
  if (m.audioMessage) {
    return {
      message_type: m.audioMessage.ptt ? "voice" : "audio",
      media: m.audioMessage,
      duration: m.audioMessage.seconds || null,
    };
  }

  // DOCUMENT
  if (m.documentMessage) {
    return {
      message_type: "document",
      media: m.documentMessage,
      file_name: m.documentMessage.fileName || null,
    };
  }

  return null;
}

function getExtensionFromMime(mime) {
  if (!mime) return "";

  // Images
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("jpg")) return ".jpg";
  if (mime.includes("png")) return ".png";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("webp")) return ".webp";

  // Video
  if (mime.includes("mp4")) return ".mp4";
  if (mime.includes("webm")) return ".webm";

  // Audio / Voice — order matters!
  // WhatsApp voice notes: "audio/ogg; codecs=opus" → save as .ogg (browser-playable)
  if (mime.includes("ogg")) return ".ogg";
  if (mime.includes("opus")) return ".ogg";  // standalone opus → save as .ogg too
  if (mime.includes("mp3") || mime.includes("mpeg")) return ".mp3";
  if (mime.includes("aac")) return ".aac";
  if (mime.includes("wav")) return ".wav";

  // Documents
  if (mime.includes("pdf")) return ".pdf";

  return "";
}

/* =====================
   MEDIA DOWNLOADER
===================== */
async function downloadMedia(media, messageType) {
  const stream = await downloadContentFromMessage(
    media,
    messageType === "voice" ? "audio" : messageType
  );

  const buffer = [];
  for await (const chunk of stream) buffer.push(chunk);

  const data = Buffer.concat(buffer);

  const ext = getExtensionFromMime(media.mimetype);

  const fileName = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}${ext}`;

  // Ensure uploads directory exists
  const uploadsDir = path.join(__dirname, "../../uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const uploadPath = path.join(uploadsDir, fileName);
  fs.writeFileSync(uploadPath, data);

  // Normalize mime for voice notes so browsers can play them
  // WhatsApp sends "audio/ogg; codecs=opus" — keep it, browsers understand it
  let normalizedMime = media.mimetype;
  if (messageType === "voice" && !normalizedMime) {
    normalizedMime = "audio/ogg; codecs=opus";
  }

  console.log(`💾 Media saved: ${fileName} (${messageType}, ${normalizedMime}, ${data.length} bytes)`);

  return {
    media_url: `/uploads/${fileName}`,
    media_mime: normalizedMime,
    media_size: data.length,  // use actual buffer size, not WhatsApp's reported size
  };
}


/**
 * Delete session folder to force fresh QR scan
 */
function deleteSessionFolder(accountId) {
  const sessionDir = path.resolve(`baileys_sessions/${accountId}`);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log(`🗑️  Deleted session folder for Account ${accountId}`);
  }
}

/**
 * Create or return existing Baileys client
 */
async function createBaileysClient(accountId, io, opts = {}) {
  accountId = Number(accountId); // normalize — maps/sets are keyed by numeric id
  if (clients.has(accountId)) return clients.get(accountId);
  // A reconnect timer and an admin "Connect" in the same second must not open
  // two sockets for one account — share the in-progress setup instead.
  if (inFlightCreates.has(accountId)) return inFlightCreates.get(accountId);
  // An explicit (non-timer) start clears a stale manual-disconnect marker.
  if (!opts._reconnect) intentionalClose.delete(accountId);
  const p = _createBaileysClient(accountId, io, opts);
  inFlightCreates.set(accountId, p);
  try {
    return await p;
  } finally {
    inFlightCreates.delete(accountId);
  }
}

async function _createBaileysClient(accountId, io, opts = {}) {

  // "Link with phone number" (pairing code) mode. If a phone was supplied now or
  // on a previous call, remember it so reconnects keep using the code flow.
  if (opts.phoneNumber) {
    const digits = String(opts.phoneNumber).replace(/\D/g, "");
    if (digits.length >= 8) pairingPhones.set(accountId, digits);
  }
  const pairPhone = pairingPhones.get(accountId) || null;

  const sessionDir = `baileys_sessions/${accountId}`;

  // Ensure session directory exists
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  // Fetch the latest WA Web version to avoid version mismatch disconnects
  let version;
  try {
    const versionInfo = await fetchLatestBaileysVersion();
    version = versionInfo.version;
    console.log(`📌 [Account ${accountId}] Using WA Web version: ${version}`);
  } catch (err) {
    console.warn(`⚠️  [Account ${accountId}] Could not fetch latest version, using default`);
  }

  const sockConfig = {
    logger: pino({ level: "silent" }),
    auth: state,
    browser: Browsers.ubuntu("FitHer CRM"), // ← proper browser identity
    connectTimeoutMs: 60000,                // ← 60s timeout instead of default
    keepAliveIntervalMs: 30000,             // ← keep connection alive
  };

  // Only set version if we successfully fetched it
  if (version) {
    sockConfig.version = version;
  }

  const sock = makeWASocket(sockConfig);

  // OUTBOUND_DISABLED=1 -> hard block on every WhatsApp send from this process
  // (campaigns, reps, automation, AI, first-touch). Nothing leaves the number.
  // OUTBOUND_ALLOWLIST (comma-separated numbers, e.g. 923001234567) lets
  // sends to those test numbers through while everything else stays blocked.
  if (process.env.OUTBOUND_DISABLED === "1") {
    const allow = new Set((process.env.OUTBOUND_ALLOWLIST || "").split(",").map(n => n.replace(/\D/g, "")).filter(Boolean));
    const realSend = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, ...rest) => {
      const num = String(jid || "").split("@")[0].split(":")[0];
      if (allow.has(num)) return realSend(jid, ...rest);
      // Privacy JIDs (@lid) hide the number: check the stored lead phone instead.
      if (allow.size && String(jid).endsWith("@lid")) {
        try {
          const [rows] = await sequelize.query("SELECT phone FROM leads WHERE whatsapp_jid = ? LIMIT 1", { replacements: [jid] });
          const ph = String((rows[0] && rows[0].phone) || "").replace(/\D/g, "");
          if (ph && allow.has(ph)) return realSend(jid, ...rest);
        } catch (_) { /* fall through to block */ }
      }
      console.warn(`🛑 [OUTBOUND_DISABLED] WhatsApp send to ${jid} BLOCKED (account ${accountId})`);
      throw new Error("Outbound messaging is disabled (OUTBOUND_DISABLED=1)");
    };
  }

  /* =====================
     PAIRING CODE ("link with phone number" instead of QR)
     Request once, shortly after the socket starts, if the account isn't
     registered yet. The 8-char code is surfaced like the QR (socket + /qr).
  ====================== */
  if (pairPhone && !state.creds.registered) {
    setTimeout(async () => {
      try {
        if (state.creds.registered) return; // already linked meanwhile
        let code = await sock.requestPairingCode(pairPhone);
        code = String(code || "").toUpperCase();
        // Present as XXXX-XXXX for readability (WhatsApp accepts with/without dash).
        const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
        pairingCodes.set(accountId, pretty);
        if (PRINT_QR) console.log(`🔗 [Account ${accountId}] Pairing code for +${pairPhone}: ${pretty}`);
        else console.log(`🔗 [Account ${accountId}] Pairing code generated (sent to admin dashboard).`);
        if (io) io.to("admins").emit("wa-pairing-code", { accountId, code: pretty, phone: pairPhone });
      } catch (e) {
        console.error(`[Account ${accountId}] requestPairingCode failed:`, e.message);
      }
    }, 3000);
  }

  /* =====================
     AUTH UPDATE
  ====================== */
  sock.ev.on("creds.update", saveCreds);

  /* =====================
     CONNECTION HANDLER
  ====================== */
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ─── DEBUG: log every connection.update ───
    console.log(`🔍 [Account ${accountId}] connection.update →`, JSON.stringify({
      connection: connection || undefined,
      qr: qr ? "(QR received)" : undefined,
      statusCode: lastDisconnect?.error?.output?.statusCode || undefined,
      errorMessage: lastDisconnect?.error?.message || undefined,
    }));

    // ─── QR CODE: display in terminal AND surface to the dashboard ───
    // Skip when this account is in "link with code" mode — the user is entering
    // a pairing code instead, so a QR would only confuse the UI.
    if (qr && !pairingPhones.has(accountId)) {
      if (PRINT_QR) {
        console.log(`\n📱 Scan this QR with WhatsApp for Account ${accountId}:\n`);
        qrcode.generate(qr, { small: true });
      } else {
        console.log(`📱 [Account ${accountId}] New QR available in the admin dashboard.`);
      }
      // Stash + push to the admin UI so a new number can be linked without
      // server/terminal access (GET /api/admin/whatsapp-accounts/:id/qr or socket).
      latestQr.set(accountId, qr);
      if (io) io.to("admins").emit("wa-qr", { accountId, qr });
    }

    if (connection === "connecting") {
      console.log(`⏳ [Account ${accountId}] Connecting to WhatsApp...`);
    }

    if (connection === "open") {
      console.log(`✅ Baileys connected: Account ${accountId}`);
      reconnectAttempts.set(accountId, 0); // reset on successful connect
      connectedAccounts.add(accountId);    // now genuinely connected
      latestQr.delete(accountId);          // QR consumed — clear it
      pairingCodes.delete(accountId);      // pairing consumed
      pairingPhones.delete(accountId);     // no longer in code mode
      if (io) io.emit("wa-connected", { accountId });

      // Backfill the real phone number once linked (created with a placeholder).
      try {
        const linkedJid = sock?.user?.id || "";
        const linkedPhone = linkedJid.split(":")[0].split("@")[0];
        await WhatsAppAccount.update(
          linkedPhone ? { phone_number: linkedPhone, status: "active" } : { status: "active" },
          { where: { id: accountId } }
        );
      } catch (e) {
        console.warn(`[Account ${accountId}] could not backfill phone_number:`, e.message);
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || "Unknown";

      console.log(`❌ [Account ${accountId}] Connection CLOSED — code: ${statusCode}, message: ${errorMsg}`);

      // Ignore "close" events fired by a STALE socket instance that has already
      // been replaced by a newer one during reconnect. Without this guard, an old
      // socket's late close event would delete the freshly-connected socket from
      // the maps, leaving a working account reported as offline.
      const isCurrentSocket = clients.get(accountId) === sock;
      if (!isCurrentSocket && clients.has(accountId)) {
        console.log(`↪️  [Account ${accountId}] Ignoring close from a superseded socket.`);
        return;
      }

      connectedAccounts.delete(accountId);
      clients.delete(accountId);
      latestQr.delete(accountId);

      // Manual disconnect → stay down, do not reconnect.
      if (intentionalClose.has(accountId)) {
        intentionalClose.delete(accountId);
        console.log(`🔌 [Account ${accountId}] Intentionally disconnected — not reconnecting.`);
        return;
      }

      // ─── SAFEGUARD: a live number just dropped ───────────────────────────
      // While a number's session is down, messages a rep sends to customers
      // DIRECTLY from the WhatsApp app/Web are NOT captured by the CRM (no chat
      // row, no last_message_at bump). Flag it loudly so it doesn't go unnoticed.
      console.warn(
        `🚨 [WA Account ${accountId}] DISCONNECTED (code ${statusCode}: ${errorMsg}). ` +
        `Direct WhatsApp sends on this number will NOT be captured until it reconnects.`
      );
      // NOTE: `status` is admin intent only (active = should be connected). An
      // unplanned drop must NOT flip it to inactive, or boot would never restart it.
      if (io) io.emit("wa-disconnected", { accountId, statusCode: statusCode || null, error: errorMsg });

      // Push the admin once for outages that won't self-heal quickly (logged out
      // or reconnect exhausted). Transient drops (e.g. 515) reconnect on their own
      // and flip status back to "active", so we don't spam a push for those.
      const notifyAdminDown = (extra = "") => {
        try {
          const { sendPushToSalesRep } = require("../services/notificationService");
          const adminRepId = parseInt(process.env.ADMIN_REP_ID || "1", 10);
          sendPushToSalesRep(
            adminRepId,
            "⚠️ WhatsApp number disconnected",
            `Account #${accountId} is offline${extra}. Direct sends won't be captured until it's reconnected.`,
            { event: "wa_disconnected", account_id: String(accountId) }
          ).catch(() => {});
        } catch {}
      };

      // 401 = loggedOut → delete session and get fresh QR
      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`🔄 [Account ${accountId}] Logged out — deleting session for fresh QR...`);
        notifyAdminDown(" — logged out, needs a QR rescan");
        deleteSessionFolder(accountId);
        reconnectAttempts.set(accountId, 0);
        scheduleReconnect(accountId, io, 3000);
        return;
      }

      // 515 = restart required by WhatsApp
      if (statusCode === 515) {
        console.log(`🔄 [Account ${accountId}] WhatsApp restart required — reconnecting immediately...`);
        reconnectAttempts.set(accountId, 0);
        scheduleReconnect(accountId, io, 2000);
        return;
      }

      // 428 = connection closed / precondition failed — often stale session
      if (statusCode === 428) {
        console.log(`⚠️  [Account ${accountId}] Precondition failed (428) — may need fresh session`);
        // Try reconnecting a few times first, if it keeps failing the user
        // should delete the session folder manually
      }

      const attempts = (reconnectAttempts.get(accountId) || 0) + 1;
      reconnectAttempts.set(accountId, attempts);

      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        if (attempts === MAX_RECONNECT_ATTEMPTS + 1) {
          console.error(`🚫 WhatsApp Account ${accountId} failed after ${MAX_RECONNECT_ATTEMPTS} attempts.`);
          console.error(`   → If it keeps failing: rm -rf baileys_sessions/${accountId}, then reconnect from the dashboard.`);
          notifyAdminDown(" — fast auto-reconnect failed, retrying every 10 min");
        }
        console.log(`🔄 Slow retry for WhatsApp ${accountId} in ${SLOW_RETRY_MS / 60000} min (attempt ${attempts})`);
        scheduleReconnect(accountId, io, SLOW_RETRY_MS);
        return;
      }

      const delay = Math.min(1000 * Math.pow(2, attempts), 60000); // 2s, 4s, 8s ... max 60s
      console.log(`🔄 Reconnecting WhatsApp ${accountId} in ${delay / 1000}s (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})`);
      scheduleReconnect(accountId, io, delay);
    }
  });

  /* =====================
     MESSAGES (TEXT + MEDIA)
  ====================== */
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg.message || !msg.key?.remoteJid) continue;

        const rawJid = msg.key.remoteJid;

        // Skip groups, status broadcast, broadcast lists, and community/newsletter – do not save
        if (rawJid.endsWith("@g.us")) continue;
        if (rawJid === "status@broadcast" || rawJid.endsWith("@broadcast")) continue;
        if (rawJid.endsWith("@newsletter")) continue;

        const whatsapp_jid = jidNormalizedUser(rawJid);

        let phone = null;
        if (whatsapp_jid.endsWith("@s.whatsapp.net")) {
          phone = whatsapp_jid.replace("@s.whatsapp.net", "");
        } else if (whatsapp_jid.endsWith("@lid")) {
          // A @lid is an opaque id and carries NO phone number. Without a
          // number she cannot be matched to her app account, so try both
          // sources before giving up.

          // 1. WhatsApp often attaches the real JID alongside the message.
          const altJid = msg.key.remoteJidAlt;
          if (altJid && altJid.endsWith("@s.whatsapp.net")) {
            phone = altJid.replace("@s.whatsapp.net", "").split(":")[0];
            console.log(`✅ LID resolved via remoteJidAlt: ${phone}`);
          }

          // 2. Baileys keeps its own phone/lid address book as part of normal
          //    operation (signalRepository.lidMapping). We were never asking
          //    it, so any message without remoteJidAlt produced a contact with
          //    no number at all. Optional-chained because the store isn't
          //    present on every version or before the socket is ready.
          if (!phone) {
            try {
              const mapped = await sock?.signalRepository?.lidMapping?.getPNForLID?.(whatsapp_jid);
              if (mapped) {
                phone = String(mapped).split("@")[0].split(":")[0].replace(/\D/g, "") || null;
                if (phone) console.log(`✅ LID resolved via lidMapping: ${phone}`);
              }
            } catch (e) {
              console.warn(`⚠️ lidMapping lookup failed for ${whatsapp_jid}: ${e.message}`);
            }
          }

          if (!phone) {
            console.warn(
              `⚠️ Could not resolve phone for LID: ${whatsapp_jid} — saving her without a number; ` +
              `she cannot be linked to an app account until a rep learns it`
            );
          }
        }

        // Her OTHER WhatsApp id (number ↔ @lid), when WhatsApp sends it or
        // Baileys knows it. frontDesk uses the pair to keep one lead per
        // woman (services/whatsappIdentity.js).
        let alt_jid = null;
        try {
          const rawAlt = msg.key.remoteJidAlt;
          if (rawAlt && !rawAlt.endsWith("@g.us")) alt_jid = jidNormalizedUser(rawAlt);
          if (!alt_jid && whatsapp_jid.endsWith("@s.whatsapp.net")) {
            const mappedLid = await sock?.signalRepository?.lidMapping?.getLIDForPN?.(whatsapp_jid);
            if (mappedLid) alt_jid = jidNormalizedUser(mappedLid);
          }
          if (!alt_jid && whatsapp_jid.endsWith("@lid") && phone) alt_jid = `${phone}@s.whatsapp.net`;
          if (alt_jid === whatsapp_jid) alt_jid = null;
        } catch { alt_jid = null; }

        const payload = extractMessagePayload(msg);
        if (!payload) continue;

        let mediaData = {};
        let mediaFailed = false;
        if (payload.media) {
          try {
            mediaData = await downloadMedia(
              payload.media,
              payload.message_type
            );
          } catch (e) {
            // Don't drop the message: save the caption/text with a note instead.
            console.error(`⚠️ [Account ${accountId}] media download failed (${payload.message_type}):`, e?.message || e);
            mediaData = {};
            mediaFailed = true;
            const note = `[${payload.message_type} received — media could not be downloaded]`;
            payload.text = payload.text ? `${note}\n${payload.text}` : note;
            payload.message_type = "text";
          }
        }

        const whatsappMessageId = msg.key.id || null;
        const fromMe = Boolean(msg.key.fromMe);

        console.log("📥 WhatsApp Event:", {
          accountId,
          whatsapp_jid,
          phone,
          message_type: payload.message_type,
          text: payload.text || null,
          whatsappMessageId,
          fromMe,
        });

        await handleIncomingWhatsAppMessage({
          whatsapp_jid,
          alt_jid,
          phone,
          text: payload.text || null,
          whatsappMessageId,
          whatsappAccountId: accountId,
          io,
          fromMe,

          // 🔥 MEDIA
          message_type: payload.message_type,
          media_failed: mediaFailed,
          duration: payload.duration || null,
          file_name: payload.file_name || null,
          ...mediaData,
        });
      } catch (err) {
        console.error("❌ Incoming WhatsApp handler error:", err);
      }
    }
  });

  /* =====================
     DELIVERY / READ RECEIPTS
  ====================== */
  sock.ev.on("messages.update", async (updates) => {
    for (const update of updates || []) {
     try {
      const messageId = update.key?.id;
      const status = update.update?.status;

      if (!messageId || !status) continue;

      if (status === 3) {
        await Message.update(
          { status: "delivered" },
          { where: { whatsapp_message_id: messageId } }
        );
        // Mirror the delivery onto the campaign recipient so nurture targeting
        // can use the delivery signal (#7).
        await sequelize.query(
          `UPDATE campaign_recipients
              SET delivered_at = COALESCE(delivered_at, NOW())
            WHERE external_message_id = :mid`,
          { replacements: { mid: messageId } }
        ).catch(() => {});
        io.emit("messageDelivered", { whatsapp_message_id: messageId });
      }

      if (status === 4) {
        await Message.update(
          { status: "read" },
          { where: { whatsapp_message_id: messageId } }
        );
        await sequelize.query(
          `UPDATE campaign_recipients
              SET read_at = COALESCE(read_at, NOW()),
                  delivered_at = COALESCE(delivered_at, NOW())
            WHERE external_message_id = :mid`,
          { replacements: { mid: messageId } }
        ).catch(() => {});
        io.emit("messageRead", { whatsapp_message_id: messageId });
      }
     } catch (err) {
      console.error(`❌ [Account ${accountId}] receipt update failed:`, err?.message || err);
     }
    }
  });

  clients.set(accountId, sock);
  return sock;
}

function getBaileysClient(accountId) {
  return clients.get(Number(accountId));
}

/** Latest unscanned QR string for an account (null once connected). */
function getLatestQr(accountId) {
  return latestQr.get(Number(accountId)) || null;
}

/** Latest pairing code ("link with phone number") for an account, or null. */
function getPairingCode(accountId) {
  return pairingCodes.get(Number(accountId)) || null;
}

/** Live connection state. Source of truth is the socket's own websocket
 *  (`sock.ws.isOpen`), so an account that is genuinely connected always reports
 *  true even if the captured "open" event was missed or the tracking set drifted
 *  during a reconnect. Falls back to the event-populated set. */
function isAccountConnected(accountId) {
  accountId = Number(accountId);
  // A pending QR / pairing code means WhatsApp is waiting for a scan: the
  // socket is open but the number is NOT logged in. Report false so the
  // admin UI shows the QR instead of a fake "Connected".
  if (latestQr.has(accountId) || pairingCodes.has(accountId)) return false;
  const sock = clients.get(accountId);
  if (sock) {
    try {
      // Open socket only counts once the session is authenticated (sock.user set).
      if (sock.ws && sock.ws.isOpen && sock.user && sock.user.id) return true;
    } catch (_) { /* ignore and fall back */ }
  }
  return connectedAccounts.has(accountId);
}

/**
 * Cleanly disconnect an account's socket WITHOUT triggering auto-reconnect.
 * The auth session on disk is preserved, so reconnecting later won't require
 * a fresh QR scan (use logout-from-phone for that).
 */
async function disconnectBaileysClient(accountId) {
  accountId = Number(accountId);
  const sock = clients.get(accountId);
  intentionalClose.add(accountId);
  connectedAccounts.delete(accountId);
  latestQr.delete(accountId);
  if (sock) {
    try {
      // end() closes the socket; the close handler sees intentionalClose and stops.
      sock.end(new Error("manual disconnect"));
    } catch (e) {
      console.warn(`[Account ${accountId}] disconnect error:`, e.message);
    }
  }
  clients.delete(accountId);
  return true;
}

module.exports = {
  createBaileysClient,
  getBaileysClient,
  getLatestQr,
  getPairingCode,
  isAccountConnected,
  disconnectBaileysClient,
};