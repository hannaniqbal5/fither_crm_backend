/**
 * tokenUsage.service.js — Phase 12.
 *
 * Logs every Gemini API call's token usage + computes cost estimate.
 * Imported by gemini.client.js wrappers.
 *
 * Pricing is loaded from `layer_system_settings` once and cached.
 * To update pricing: admin updates the setting row; next process restart picks up changes.
 */

const sequelize = require("../config/database");

// Cache pricing for the lifetime of the process (refreshable via reloadPricing())
let pricing = {
  input_per_1m_usd: 0.075,
  output_per_1m_usd: 0.30,
  embedding_per_1m_usd: 0.025,
  usd_to_pkr_rate: 278,
};
let pricingLoaded = false;

// Per-model list prices (USD per 1M tokens, Google Gemini API, Nov 2026).
// Thinking tokens are billed as output. A model not listed here uses the
// admin-set ai_price_* settings above.
const MODEL_PRICES = {
  "gemini-3.1-pro":        { in: 2.0, out: 12.0 },   // prompts up to 200K tokens
  "gemini-2.5-pro":        { in: 1.25, out: 10.0 },
  "gemini-2.5-flash":      { in: 0.30, out: 2.50 },
  "gemini-2.5-flash-lite": { in: 0.10, out: 0.40 },
  "gemini-embedding-001":  { in: 0.15, out: 0 },
  // Text-to-speech (voice-note replies). Audio = 25 tokens per second.
  "gemini-3.1-flash-tts":         { in: 1.0, out: 20.0 },
  "gemini-2.5-flash-preview-tts": { in: 0.5, out: 10.0 },
  "gemini-2.5-pro-preview-tts":   { in: 1.0, out: 20.0 },
};
const priceFor = (model) => {
  const m = String(model || "").toLowerCase();
  const key = Object.keys(MODEL_PRICES).sort((a, b) => b.length - a.length).find((k) => m.startsWith(k));
  return key ? MODEL_PRICES[key] : null;
};

async function reloadPricing() {
  try {
    const [rows] = await sequelize.query(
      `SELECT setting_key, setting_value FROM layer_system_settings
        WHERE setting_key LIKE 'ai_price_%' OR setting_key = 'ai_usd_to_pkr_rate'`
    );
    rows.forEach(r => {
      const v = parseFloat(r.setting_value);
      if (Number.isNaN(v)) return;
      if (r.setting_key === "ai_price_input_per_1m_usd")     pricing.input_per_1m_usd = v;
      if (r.setting_key === "ai_price_output_per_1m_usd")    pricing.output_per_1m_usd = v;
      if (r.setting_key === "ai_price_embedding_per_1m_usd") pricing.embedding_per_1m_usd = v;
      if (r.setting_key === "ai_usd_to_pkr_rate")            pricing.usd_to_pkr_rate = v;
    });
    pricingLoaded = true;
  } catch (err) {
    console.warn("[tokenUsage] Pricing reload failed (using defaults):", err.message);
  }
}

function computeCostUsd({ prompt_tokens, completion_tokens, operation, model }) {
  const known = priceFor(model);
  if (known) {
    return ((prompt_tokens || 0) / 1_000_000) * known.in + ((completion_tokens || 0) / 1_000_000) * known.out;
  }
  if (operation && operation.startsWith("embedding")) {
    // embedding calls only have prompt tokens
    return (prompt_tokens / 1_000_000) * pricing.embedding_per_1m_usd;
  }
  const inputCost  = (prompt_tokens     / 1_000_000) * pricing.input_per_1m_usd;
  const outputCost = (completion_tokens / 1_000_000) * pricing.output_per_1m_usd;
  return inputCost + outputCost;
}

/**
 * logCall — write a single usage row. NEVER throws.
 *
 * @param {object} args
 *   @param {string} args.operation   reply | classifier | embedding_query | embedding_ingest | followup_draft | other
 *   @param {string} args.model
 *   @param {number} args.prompt_tokens
 *   @param {number} args.completion_tokens
 *   @param {number} args.latency_ms
 *   @param {boolean} [args.success=true]
 *   @param {string} [args.error_message]
 *   @param {string} [args.reply_id]
 *   @param {number} [args.lead_id]
 *   @param {number} [args.rep_id]
 */
async function logCall({
  operation, model,
  prompt_tokens = 0, completion_tokens = 0,
  latency_ms = null,
  success = true, error_message = null,
  reply_id = null, lead_id = null, rep_id = null,
}) {
  try {
    if (!pricingLoaded) await reloadPricing();
    const total_tokens = (prompt_tokens || 0) + (completion_tokens || 0);
    const cost_usd = computeCostUsd({ prompt_tokens, completion_tokens, operation, model });

    await sequelize.query(
      `INSERT INTO ai_token_usage
         (operation, model, prompt_tokens, completion_tokens, total_tokens,
          cost_usd, latency_ms, success, error_message,
          reply_id, lead_id, rep_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          operation, model,
          prompt_tokens, completion_tokens, total_tokens,
          cost_usd, latency_ms, success ? 1 : 0, error_message,
          reply_id, lead_id, rep_id,
        ],
      }
    );
  } catch (err) {
    console.error("⚠️  [tokenUsage] log failed:", err.message);
  }
}

/**
 * Helper to extract token counts from Gemini's response.usageMetadata.
 * Returns { prompt_tokens, completion_tokens }.
 */
function extractTokens(geminiResponse) {
  const u = geminiResponse && geminiResponse.usageMetadata;
  if (!u) return { prompt_tokens: 0, completion_tokens: 0 };
  return {
    prompt_tokens:     Number(u.promptTokenCount     || 0),
    // Thinking tokens are billed at the output rate — count them as output.
    completion_tokens: Number(u.candidatesTokenCount || 0) + Number(u.thoughtsTokenCount || 0),
  };
}

module.exports = { logCall, computeCostUsd, extractTokens, reloadPricing, pricing };
