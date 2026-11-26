/**
 * gemini.client.js — single shared Gemini SDK instance.
 *
 * All AI services import from here. Keeping one client instance avoids
 * connection / quota duplication.
 *
 * Phase 12: every call is logged to ai_token_usage with prompt/completion tokens
 * + estimated USD cost. Pass `context` so the log row gets the right tags.
 *
 * Set GEMINI_API_KEY in .env. Get one at https://aistudio.google.com/app/apikey
 */

const { GoogleGenAI } = require("@google/genai");
const { logCall, extractTokens } = require("../services/tokenUsage.service");

const apiKey = process.env.GEMINI_API_KEY;
const llmModelName = process.env.GEMINI_LLM_MODEL || "gemini-2.5-flash";
const embedModelName = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
// The customer-facing reply can use a stronger model than the background
// jobs (intent classifier, voice transcription), which stay on GEMINI_LLM_MODEL.
// e.g. GEMINI_REPLY_MODEL=gemini-2.5-pro. Unset = same as GEMINI_LLM_MODEL.
const replyModelName = process.env.GEMINI_REPLY_MODEL || llmModelName;
const modelFor = (operation) => (operation === "reply" ? replyModelName : llmModelName);

// How long the model "thinks" before answering — most of a reply's wait.
// Gemini 3 models take a thinking LEVEL (MINIMAL/LOW/MEDIUM/HIGH; unset means
// HIGH, the slowest). WhatsApp replies are short, so LOW keeps the same model
// and cuts seconds. GEMINI_REPLY_THINKING overrides it for replies.
// Gemini 2.5 models keep the old token budget.
const REPLY_THINKING = String(process.env.GEMINI_REPLY_THINKING || "LOW").trim().toUpperCase();
function thinkingFor(model, operation) {
  if (/^gemini-3/i.test(String(model))) {
    const level = operation === "reply" ? REPLY_THINKING : "LOW";
    if (["MINIMAL", "LOW", "MEDIUM", "HIGH"].includes(level)) return { thinkingLevel: level };
    return {};
  }
  return { thinkingBudget: 1024 };
}

if (!apiKey) {
  console.warn("[Gemini] GEMINI_API_KEY is not set - AI agent will fail. Add it to .env");
}

// Per-request timeout (ms) — @google/genai `httpOptions.timeout` aborts the
// fetch after this long, so a hung Gemini call can't stall a reply forever.
const REQUEST_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || "30000", 10);
const MAX_ATTEMPTS = 3;                       // 1 try + 2 retries
const RETRYABLE_STATUS = new Set([429, 500, 503]);

const genAI = new GoogleGenAI({
  apiKey: apiKey || "missing",
  httpOptions: { timeout: REQUEST_TIMEOUT_MS },
});

function _statusOf(err) {
  const s = Number(err?.status ?? err?.code ?? err?.response?.status);
  if (Number.isFinite(s)) return s;
  const m = String(err?.message || "").match(/\b(429|500|503)\b/);
  return m ? Number(m[1]) : null;
}

/** Retry `fn` on 429/500/503 with exponential backoff + jitter (max 3 tries). */
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = _statusOf(err);
      if (attempt >= MAX_ATTEMPTS || !RETRYABLE_STATUS.has(status)) throw err;
      const delay = 1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400); // ~1s, ~2s
      console.warn(`[Gemini] ${label} got ${status} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * generateText - call the Gemini LLM.
 *
 * @param {string} userMessage      - the user's latest message
 * @param {string} systemInstruction - full system prompt
 * @param {object} [context]         - { operation, reply_id, lead_id, rep_id } for logging
 * @returns {Promise<string>}        - the LLM's response text
 */
async function generateText(userMessage, systemInstruction, context = {}) {
  const t0 = Date.now();
  const operation = context.operation || "reply";
  const model = modelFor(operation);
  try {
    const response = await withRetry(() => genAI.models.generateContent({
      model,
      contents: userMessage,
      config: {
        systemInstruction,
        temperature: 0.7,
        // 1500 = roughly 600-800 tokens for visible reply after thinking.
        // Empirically, replies fit in <300 tokens but cushion avoids cutoffs.
        maxOutputTokens: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || "3000", 10),
        topP: 0.9,
        // gemini-2.5-flash has "thinking" enabled by default. Setting it
        // to 0 caused empty replies (model needs room to plan when the
        // system prompt has multiple constraints). A small positive
        // budget gives it just enough to plan without burning all output.
        thinkingConfig: thinkingFor(model, operation),
      },
    }), operation);

    const { prompt_tokens, completion_tokens } = extractTokens(response);

    // Primary path: SDK getter. Falls back to manual candidates extraction
    // if the getter returns empty.
    let text = "";
    try { text = (response && response.text) || ""; } catch { /* ignore */ }
    if (!text && response?.candidates?.[0]?.content?.parts) {
      text = response.candidates[0].content.parts
        .map(p => p.text || "")
        .join("")
        .trim();
    }

    // Diagnostic: log non-STOP finishReasons so we can spot
    // SAFETY / MAX_TOKENS / RECITATION cutoffs in real time.
    const finishReason = response?.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== "STOP") {
      console.warn(`[Gemini] finishReason=${finishReason} for ${operation} reply_id=${context.reply_id || "?"}`);
    }

    // Empty / blank output (SAFETY, MAX_TOKENS spent on thinking, …) is a
    // FAILURE — callers save it as status='failed', never as an empty draft.
    if (!String(text || "").trim()) {
      const e = new Error(`Gemini returned empty text (finishReason=${finishReason || "unknown"})`);
      e.tokens = { prompt_tokens, completion_tokens };
      throw e;
    }

    logCall({
      operation, model,
      prompt_tokens, completion_tokens,
      latency_ms: Date.now() - t0,
      success: true,
      reply_id: context.reply_id || null,
      lead_id:  context.lead_id  || null,
      rep_id:   context.rep_id   || null,
    }).catch(() => {});

    return text;
  } catch (err) {
    logCall({
      operation, model,
      prompt_tokens: err.tokens?.prompt_tokens, completion_tokens: err.tokens?.completion_tokens,
      latency_ms: Date.now() - t0,
      success: false, error_message: err.message?.slice(0, 250),
      reply_id: context.reply_id || null,
      lead_id:  context.lead_id  || null,
    }).catch(() => {});
    throw err;
  }
}

/**
 * embedText - call the Gemini embedding model.
 *
 * @param {string} text - the text to embed
 * @param {object} [context] - { operation: 'embedding_query' | 'embedding_ingest' }
 * @returns {Promise<number[]>} - 768-dim vector
 */
async function embedText(text, context = {}) {
  const t0 = Date.now();
  const operation = context.operation || "embedding_query";
  try {
    const response = await withRetry(() => genAI.models.embedContent({
      model: embedModelName,
      contents: text,
      config: { outputDimensionality: 768 },
    }), operation);

    // Embedding API doesn't reliably return usageMetadata; estimate ~tokens = chars/4
    const promptTokensEstimate = Math.max(1, Math.ceil((text || "").length / 4));

    logCall({
      operation, model: embedModelName,
      prompt_tokens: promptTokensEstimate,
      completion_tokens: 0,
      latency_ms: Date.now() - t0,
      success: true,
    }).catch(() => {});

    // Response shape: { embeddings: [{ values: [...] }] }
    if (response.embeddings && response.embeddings[0] && response.embeddings[0].values) {
      return response.embeddings[0].values;
    }

    // Fallback for older SDK shape
    if (response.embedding && response.embedding.values) {
      return response.embedding.values;
    }

    throw new Error("Unexpected embedding response shape from Gemini");
  } catch (err) {
    logCall({
      operation, model: embedModelName,
      latency_ms: Date.now() - t0,
      success: false, error_message: err.message?.slice(0, 250),
    }).catch(() => {});
    throw err;
  }
}

module.exports = { generateText, embedText };
