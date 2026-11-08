/**
 * voiceTranscription.service.js — Phase 17.
 *
 * Transcribes WhatsApp voice notes (and any audio message) using Gemini 2.5
 * Flash's native audio understanding. Returns a clean text transcript that
 * the rest of the AI pipeline (Layer 1 intent → Layer 2 classifier → Fiza)
 * can consume as if the customer had typed it.
 *
 * Why Gemini and not Whisper / Google STT:
 *   - Gemini handles Roman Urdu + Urdu + English code-switching natively
 *   - No separate API key, no separate billing
 *   - Cost ~$0.003 per ~30-sec voice (gemini-2.5-flash, inline audio)
 *   - Latency 2-4 sec for voices < 60 sec
 *
 * Limits:
 *   - Audio file must be < 20 MB
 *   - Gemini supports up to ~30 min audio in one call
 *   - Common WhatsApp formats supported: ogg/opus, mp3, m4a, wav, aac
 *
 * Returns: { text, language, confidence } or null on failure.
 */

const fsSync = require("fs");
const path   = require("path");
const sequelize = require("../config/database");
const { GoogleGenAI } = require("@google/genai");
const { logCall } = require("../services/tokenUsage.service");

const apiKey = process.env.GEMINI_API_KEY;
const modelName = process.env.GEMINI_LLM_MODEL || "gemini-2.5-flash";
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;  // 20 MB safety cap

const genAI = new GoogleGenAI({ apiKey: apiKey || "missing" });

const TRANSCRIBE_PROMPT = `You are transcribing a WhatsApp voice note from a Pakistani woman customer of FitHer (a women's wellness app).

Transcribe the audio as accurately as possible. The speaker is likely speaking in:
- Roman Urdu (Urdu written with Latin letters, e.g. "kitne ka hai")
- Urdu script
- English
- A mix of two or three of the above

Rules:
1. Output the transcript in the SAME script the speaker uses.
   - If she speaks Urdu, return Roman Urdu transcription (preferred) OR Urdu script — pick whichever feels more natural for the audio.
   - If she speaks English, return English.
   - If mixed, transcribe each segment in its natural script.
2. Do NOT translate. Just transcribe what she actually said.
3. Keep filler words like "umm", "aaa", "to" if they're clear and meaningful — drop them only if they obscure the message.
4. Preserve emotion or tone clues only if they're VERY clear (e.g. crying, laughing in [brackets]).
5. Return ONLY the transcript as a JSON object — no prose around it:

{
  "text": "...transcript...",
  "language": "ur|en|mixed",
  "confidence": 0.0-1.0,
  "duration_sec": <approximate seconds>
}

If the audio is unintelligible / silent / corrupted, return:
{ "text": "", "language": "unknown", "confidence": 0, "duration_sec": 0 }`;

function inferMimeFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".ogg" || ext === ".opus") return "audio/ogg";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".aac") return "audio/aac";
  if (ext === ".webm") return "audio/webm";
  return "audio/ogg"; // most WhatsApp voice notes
}

function safeParse(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * transcribeFromPath — main entry.
 *
 * @param {string} filePath  — local absolute path to audio file
 * @param {object} [opts]
 *   @param {string} [opts.mimeType] — override; auto-detected from extension
 *   @param {number} [opts.leadId]   — for token-usage logging
 *   @param {number} [opts.messageId]
 * @returns {Promise<{text, language, confidence, duration_sec} | null>}
 */
async function transcribeFromPath(filePath, opts = {}) {
  if (!apiKey) {
    console.warn("[voiceTx] GEMINI_API_KEY missing — cannot transcribe");
    return null;
  }
  if (!filePath || !fsSync.existsSync(filePath)) {
    console.warn(`[voiceTx] file missing: ${filePath}`);
    return null;
  }
  const stat = fsSync.statSync(filePath);
  if (stat.size > MAX_AUDIO_BYTES) {
    console.warn(`[voiceTx] file too large (${stat.size}B > ${MAX_AUDIO_BYTES}B): ${filePath}`);
    return null;
  }

  const t0 = Date.now();
  const mime = opts.mimeType || inferMimeFromPath(filePath);

  try {
    const audioBuffer = fsSync.readFileSync(filePath);
    const audioB64    = audioBuffer.toString("base64");

    const response = await genAI.models.generateContent({
      model: modelName,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mime, data: audioB64 } },
            { text: TRANSCRIBE_PROMPT },
          ],
        },
      ],
      config: {
        temperature: 0.1,       // deterministic transcription, no creativity
        maxOutputTokens: 800,
      },
    });

    // Log token usage
    const u = response?.usageMetadata || {};
    logCall({
      operation: "voice_transcribe",
      model: modelName,
      prompt_tokens: Number(u.promptTokenCount || 0),
      completion_tokens: Number(u.candidatesTokenCount || 0),
      latency_ms: Date.now() - t0,
      success: true,
      lead_id: opts.leadId || null,
    }).catch(() => {});

    const raw = response?.text || "";
    const parsed = safeParse(raw);

    if (!parsed || typeof parsed.text !== "string") {
      console.warn("[voiceTx] couldn't parse transcript JSON:", raw.slice(0, 200));
      return null;
    }

    const transcript = {
      text:         String(parsed.text || "").trim(),
      language:     parsed.language || "unknown",
      confidence:   typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      duration_sec: Number(parsed.duration_sec || 0),
    };

    console.log(
      `🎙️  [voiceTx] transcribed (${transcript.language}, conf ${transcript.confidence.toFixed(2)}, ${Date.now()-t0}ms): ` +
      `"${transcript.text.slice(0, 80)}${transcript.text.length > 80 ? "…" : ""}"`
    );

    return transcript;
  } catch (err) {
    console.error("[voiceTx] failed:", err.message);
    logCall({
      operation: "voice_transcribe",
      model: modelName,
      latency_ms: Date.now() - t0,
      success: false,
      error_message: err.message?.slice(0, 250),
      lead_id: opts.leadId || null,
    }).catch(() => {});
    return null;
  }
}

/**
 * persistTranscript — save the transcript onto the messages row.
 */
async function persistTranscript(messageId, transcript) {
  if (!messageId || !transcript) return;
  try {
    await sequelize.query(
      `UPDATE messages
          SET voice_transcript = ?,
              voice_transcript_lang = ?,
              voice_confidence = ?,
              voice_transcribed_at = NOW()
        WHERE id = ?`,
      {
        replacements: [
          transcript.text || "",
          transcript.language || "unknown",
          transcript.confidence || 0,
          messageId,
        ],
      }
    );
  } catch (err) {
    console.error("[voiceTx] persistTranscript failed:", err.message);
  }
}

/**
 * resolveMediaPath — turn the message.media_url (relative path like
 * "/uploads/voice_xyz.ogg") into an absolute filesystem path.
 */
function resolveMediaPath(mediaUrl) {
  if (!mediaUrl) return null;
  // Already absolute
  if (path.isAbsolute(mediaUrl) && fsSync.existsSync(mediaUrl)) return mediaUrl;
  // Relative to project root: /uploads/...
  const projectRoot = path.join(__dirname, "..", "..");
  const candidates = [
    path.join(projectRoot, mediaUrl.replace(/^\//, "")),
    path.join(projectRoot, "uploads", path.basename(mediaUrl)),
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(c)) return c;
  }
  return null;
}

module.exports = {
  transcribeFromPath,
  persistTranscript,
  resolveMediaPath,
};
