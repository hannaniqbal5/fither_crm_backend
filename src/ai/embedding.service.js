/**
 * embedding.service.js — thin wrapper around gemini.client.embedText.
 *
 * Exists as a separate file so we can later swap providers (e.g. local
 * sentence-transformers) without touching retrieval or ingestion code.
 */

const { embedText } = require("./gemini.client");

async function embed(text, context = {}) {
  if (!text || !text.trim()) {
    throw new Error("embed() called with empty text");
  }
  return embedText(text, { operation: "embedding_query", ...context });
}

async function embedBatch(texts, context = {}) {
  // Simple sequential — Gemini free tier rate-limits aggressive parallel calls.
  // Switch to Promise.all if you upgrade to paid tier and need throughput.
  const results = [];
  for (const t of texts) {
    results.push(await embedText(t, { operation: "embedding_ingest", ...context }));
  }
  return results;
}

module.exports = { embed, embedBatch };
