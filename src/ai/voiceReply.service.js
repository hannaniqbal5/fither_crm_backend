/**
 * voiceReply.service.js — Fiza answers a voice note with a voice note (Nov 2026).
 *
 * When a customer sent a VOICE NOTE and a rep approves Fiza's reply, the text
 * goes out as usual and this sends the same reply as a WhatsApp voice note
 * (Gemini text-to-speech → OGG/Opus → ptt). Text-only chats are untouched.
 *
 * .env
 *   VOICE_REPLY_ENABLED=true            turn the feature on (off by default)
 *   VOICE_REPLY_TEST_ONLY=true          only for numbers in VOICE_REPLY_TEST_NUMBERS
 *                                      (default true — set false to go live)
 *   VOICE_REPLY_TEST_NUMBERS=923…       comma list; defaults to OUTBOUND_ALLOWLIST
 *   GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview   (falls back to gemini-2.5-flash-preview-tts)
 *   GEMINI_TTS_VOICE=Kore               a female prebuilt voice
 *
 * Never throws to the caller — a failed voice note just logs; the text reply
 * has already been sent.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { GoogleGenAI } = require("@google/genai");
const sequelize = require("../config/database");
const { logCall } = require("../services/tokenUsage.service");

const UPLOAD_DIR = path.join(__dirname, "../../uploads");
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview";
const TTS_FALLBACK = "gemini-2.5-flash-preview-tts";
const VOICE = process.env.GEMINI_TTS_VOICE || "Kore";
const MAX_CHARS = 600; // ~40 s of speech — voice notes should stay short

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "missing",
  httpOptions: { timeout: 45000 },
});

const digits = (s) => String(s || "").replace(/\D/g, "");

function testNumbers() {
  return new Set(
    String(process.env.VOICE_REPLY_TEST_NUMBERS || process.env.OUTBOUND_ALLOWLIST || "")
      .split(",").map(digits).filter(Boolean)
  );
}

/** Should this approved reply also go out as a voice note? */
async function shouldVoiceReply(draft) {
  if (process.env.VOICE_REPLY_ENABLED !== "true") return false;
  if (process.env.VOICE_REPLY_TEST_ONLY !== "false" && !testNumbers().has(digits(draft.phone))) return false;
  if (!draft.message_id) return false;
  const [[m]] = await sequelize.query(
    "SELECT message_type FROM messages WHERE id = :id",
    { replacements: { id: draft.message_id } }
  );
  return !!m && (m.message_type === "voice" || m.message_type === "audio");
}

/** Clean text for speech: no emojis, links, markdown or long dashes. */
function speakable(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/[*_#`]/g, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_CHARS);
}

async function ttsPcm(text, model) {
  const t0 = Date.now();
  const prompt =
    "Read this WhatsApp reply aloud as a warm, friendly Pakistani woman from the FitHer team, " +
    "at a natural relaxed pace. If it is in Roman Urdu, pronounce it as spoken Urdu:\n\n" + text;
  const res = await genAI.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
  });
  const b64 = res?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!b64) throw new Error("TTS returned no audio");
  const u = res.usageMetadata || {};
  logCall({
    operation: "tts", model,
    prompt_tokens: Number(u.promptTokenCount || 0),
    completion_tokens: Number(u.candidatesTokenCount || 0),
    latency_ms: Date.now() - t0, success: true,
  }).catch(() => {});
  return Buffer.from(b64, "base64"); // 24 kHz, 16-bit, mono PCM
}

/** PCM (24 kHz s16le mono) → OGG/Opus file, the format WhatsApp plays as a voice note. */
function toOgg(pcm, outPath) {
  const rawPath = outPath.replace(/\.ogg$/, ".pcm");
  fs.writeFileSync(rawPath, pcm);
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ["-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", rawPath, "-c:a", "libopus", "-b:a", "24k", "-ar", "48000", outPath],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, _o, stderr) => {
        try { fs.unlinkSync(rawPath); } catch (_) { /* ignore */ }
        if (err) { err.stderr = stderr; return reject(err); }
        resolve();
      }
    );
  });
}

/** Makes the OGG voice file for `text`. Returns { fileName, oggPath, seconds, model }. */
async function makeVoiceFile(text, tag = "test") {
  const clean = speakable(text);
  if (!clean) throw new Error("nothing_to_say");
  let pcm, model = TTS_MODEL;
  try {
    pcm = await ttsPcm(clean, TTS_MODEL);
  } catch (e) {
    if (TTS_MODEL === TTS_FALLBACK) throw e;
    console.warn(`[voiceReply] ${TTS_MODEL} failed (${e.message}); trying ${TTS_FALLBACK}`);
    model = TTS_FALLBACK;
    pcm = await ttsPcm(clean, TTS_FALLBACK);
  }
  const seconds = Math.round(pcm.length / (24000 * 2));
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const fileName = `fiza_voice_${tag}_${Date.now()}.ogg`;
  const oggPath = path.join(UPLOAD_DIR, fileName);
  await toOgg(pcm, oggPath);
  return { fileName, oggPath, seconds, model, clean };
}

/**
 * Sends `text` as a voice note to the lead in `draft` (fields: leadId,
 * whatsapp_jid, whatsapp_account_id, assigned_to). Returns { sent, error? }.
 */
async function sendVoiceReply(draft, text, io) {
  try {
    if (!speakable(text)) return { sent: false, error: "nothing_to_say" };
    const { fileName, oggPath, seconds, clean } = await makeVoiceFile(text, String(draft.leadId));

    const { getBaileysClient } = require("../whatsapp/baileysClient");
    const sock = getBaileysClient(draft.whatsapp_account_id);
    if (!sock) return { sent: false, error: "wa_not_connected" };
    const audio = fs.readFileSync(oggPath);
    const sent = await sock.sendMessage(draft.whatsapp_jid, {
      audio, mimetype: "audio/ogg; codecs=opus", ptt: true, seconds,
    });

    const { saveMessage } = require("../whatsapp/message.service");
    const { message } = await saveMessage({
      whatsapp_jid: draft.whatsapp_jid,
      whatsappAccountId: draft.whatsapp_account_id,
      repId: draft.assigned_to,
      from: "bot",
      direction: "OUT",
      status: "sent",
      whatsappMessageId: sent?.key?.id || null,
      message: clean, // the words, so reps can read what was said
      message_type: "voice",
      media_url: `/uploads/${fileName}`,
      media_mime: "audio/ogg; codecs=opus",
      media_size: audio.length,
      duration: seconds,
      file_name: fileName,
    });
    try {
      if (io && draft.assigned_to) io.to(`rep_${draft.assigned_to}`).emit("newMessage", message.toJSON());
    } catch (_) { /* live update is optional */ }
    console.log(`🎙️  [voiceReply] voice note sent to lead ${draft.leadId} (${seconds}s)`);
    return { sent: true, seconds };
  } catch (err) {
    console.error("[voiceReply] failed:", err.message, err.stderr ? String(err.stderr).slice(-300) : "");
    return { sent: false, error: err.message };
  }
}

module.exports = { shouldVoiceReply, sendVoiceReply, makeVoiceFile, speakable };
