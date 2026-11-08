const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const { People } = require("../../models");
const { getBaileysClient } = require("./baileysClient");
const { saveMessage } = require("./message.service");
const { assertOwnsOr403 } = require("../middleware/leadOwnership");

// Async ffmpeg (does not block the event loop like execSync did).
// Same args as before; execFile passes them without a shell.
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve();
    });
  });
}

async function sendMediaMessage(req, res) {
  try {
    const { lead_id, client_id } = req.body;
    const file = req.file;

    if (!file || !lead_id) {
      return res.status(400).json({ error: "Missing media or lead_id" });
    }

    const person = await People.findByPk(lead_id);
    if (!person) {
      return res.status(404).json({ error: "Person not found" });
    }
    if (!assertOwnsOr403(req, res, person)) return;

    const sock = getBaileysClient(person.whatsapp_account_id);
    if (!sock) {
      return res.status(500).json({ error: "WhatsApp not connected" });
    }

    const mime = file.mimetype;
    let messageType = "document";

    if (mime.startsWith("image/")) messageType = "image";
    else if (mime.startsWith("video/")) messageType = "video";
    else if (mime.startsWith("audio/")) messageType = "audio";

    let filePath = file.path;
    let finalMime = mime;
    let duration = null;

    if (messageType === "audio") {
      const dir = path.dirname(file.path);
      const base = path.basename(file.path, path.extname(file.path));
      const oggPath = path.join(dir, `${base}.ogg`);

      await runFfmpeg(["-y", "-i", file.path, "-c:a", "libopus", "-b:a", "24k", oggPath]);

      filePath = oggPath;
      finalMime = "audio/ogg; codecs=opus";
    }

    const ext =
      path.extname(filePath) ||
      (messageType === "audio" ? ".ogg"
        : messageType === "image" ? ".jpg"
        : messageType === "video" ? ".mp4"
        : "");

    const finalFileName =
      file.originalname && file.originalname.includes(".")
        ? file.originalname
        : `${messageType}_${Date.now()}${ext}`;

    let messagePayload;

    if (messageType === "audio") {
      messagePayload = {
        audio: fs.readFileSync(filePath),
        mimetype: finalMime,
        ptt: true,
      };
    } else {
      messagePayload = {
        [messageType]: fs.readFileSync(filePath),
        mimetype: finalMime,
        fileName: finalFileName,
      };
    }

    const sentMsg = await sock.sendMessage(person.whatsapp_jid, messagePayload);

    if (!sentMsg?.key?.id) {
      throw new Error("WhatsApp sendMessage failed");
    }

    const { message } = await saveMessage({
      whatsapp_jid: person.whatsapp_jid,
      whatsappAccountId: person.whatsapp_account_id,
      repId: person.assigned_to,
      from: "rep",
      direction: "OUT",
      status: "sent",
      whatsappMessageId: sentMsg.key.id,
      message: null,
      message_type: messageType,
      media_url: `/uploads/${path.basename(filePath)}`,
      media_mime: finalMime,
      media_size: fs.statSync(filePath).size,
      duration,
      file_name: finalFileName,
    });

    // Echo client_id (not a DB column) so the dashboard can replace its
    // optimistic bubble — same contract as the text send in leads.controller.
    const payload = { ...message.toJSON(), client_id: client_id || null };
    const io = req.app.get("io");
    if (io && req.user?.repId) io.to(`rep_${req.user.repId}`).emit("newMessage", payload);

    return res.json({ success: true, message: payload });

  } catch (err) {
    console.error("❌ sendMediaMessage error:", err);
    return res.status(500).json({ error: "Media send failed" });
  }
}

module.exports = { sendMediaMessage };
