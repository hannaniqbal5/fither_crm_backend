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

function computeCostUsd({ prompt_tokens, completion_tokens, operation }) {
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
    const cost_usd = computeCostUsd({ prompt_tokens, completion_tokens, operation });

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
