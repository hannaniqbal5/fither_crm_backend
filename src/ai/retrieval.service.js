/**
 * retrieval.service.js — semantic search over kb_chunks.
 *
 * Strategy:
 *   1. Embed user's query via Gemini text-embedding-004
 *   2. Load all kb_chunks into memory (cached for 5min)
 *   3. Cosine-similarity score every chunk
 *   4. Apply intent boost (keyword-based) so e.g. "kitne ka hai" prefers
 *      pricing chunks even if semantic score is close
 *   5. Return top-K
 *
 * At FitHer's scale (~50–500 chunks), in-memory cosine in Node.js is <50ms.
 * No vector DB needed.
 */

const { embed } = require("./embedding.service");
const sequelize = require("../config/database");
const { MODE_CATEGORIES } = require("./kb.categories");

let chunkCache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function loadChunks() {
  if (chunkCache && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return chunkCache;
  }

  const [rows] = await sequelize.query(
    "SELECT chunk_id, source_file, section_title, category, chunk_text, embedding FROM kb_chunks"
  );

  chunkCache = rows.map(r => ({
    chunk_id:      r.chunk_id,
    source_file:   r.source_file,
    section_title: r.section_title,
    category:      r.category || 'basic_info',
    chunk_text:    r.chunk_text,
    embedding:     typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding,
  }));
  cacheTimestamp = Date.now();

  console.log(`📚 [Retrieval] Loaded ${chunkCache.length} chunks into cache`);
  return chunkCache;
}

/**
 * Lightweight intent boost — adds a small score bump when the user query
 * contains keywords associated with a particular knowledge file. Keeps the
 * AI from confidently retrieving the wrong cluster.
 */
function intentBoost(query, sourceFile) {
  const q = (query || "").toLowerCase();
  const f = (sourceFile || "").toLowerCase();

  if (f.includes("pricing") || f.includes("payment") || f.includes("onboarding")) {
    if (/price|kitne|kitna|fees|amount|payment|rs\.?|pkr|monthly|charge/.test(q)) return 0.05;
  }
  if (f.includes("women_health") || f.includes("womens_health") || f.includes("health_conditions")) {
    if (/pcos|pco|pcod|hormone|periods|thyroid|diabetes|postpartum|pregnan|hair fall|baal/.test(q)) return 0.05;
  }
  if (f.includes("weight_loss") || f.includes("weight-loss")) {
    if (/weight|wazan|kam|belly|fat|inch|stuck|plateau|metabolism/.test(q)) return 0.05;
  }
  if (f.includes("workout") || f.includes("diet") || f.includes("logistics")) {
    if (/workout|exercise|class|home|gym|diet|food|khana|busy|time|beginner/.test(q)) return 0.05;
  }
  if (f.includes("objection") || f.includes("motivation")) {
    if (/mehn?ga|expensive|pehle try|husband|family|discount|nahin|cant|cannot|sahi nahin/.test(q)) return 0.05;
  }
  if (f.includes("brand") || f.includes("program")) {
    if (/fither|kya hai|what is|about|kaisa hai|founders|hannan|shaista/.test(q)) return 0.05;
  }
  if (f.includes("trainer") || f.includes("community")) {
    if (/trainer|coach|community|group|akeli|alone|stories|transformation|results/.test(q)) return 0.05;
  }
  return 0;
}

/**
 * retrieve — top-K most relevant chunks for a query.
 *
 * @param {string} query    — user's latest message
 * @param {object} [opts]
 *   @param {string} [opts.mode] — "sales" (default) | "winback" | "support"
 *                                  Filters chunks to only those allowed by the mode.
 *   @param {number} [opts.topK] — defaults to AI_MAX_RETRIEVAL_CHUNKS or 5
 * @returns {Promise<Array<{ chunk_id, source_file, section_title, category, chunk_text, score }>>}
 *
 * Backwards-compatible: `retrieve(query, 5)` still works (second arg as topK).
 */
async function retrieve(query, opts) {
  // Back-compat: if a number was passed as opts, treat as topK
  let mode, topK;
  if (typeof opts === 'number') {
    topK = opts;
  } else if (opts && typeof opts === 'object') {
    mode = opts.mode;
    topK = opts.topK;
  }

  const k = topK || parseInt(process.env.AI_MAX_RETRIEVAL_CHUNKS, 10) || 5;
  const allChunks = await loadChunks();

  if (allChunks.length === 0) {
    console.warn("⚠️  [Retrieval] kb_chunks is empty — run `npm run ai:ingest`");
    return [];
  }

  // Mode-based category filter — pick only chunks tagged with categories
  // allowed by the current Fiza mode.
  const allowedCategories = (mode && MODE_CATEGORIES[mode]) ? new Set(MODE_CATEGORIES[mode]) : null;
  const chunks = allowedCategories
    ? allChunks.filter(c => allowedCategories.has(c.category))
    : allChunks;

  if (chunks.length === 0 && mode) {
    console.warn(`⚠️  [Retrieval] No chunks for mode='${mode}' — falling back to all chunks`);
    // Fallback prevents Fiza from going silent if a mode has no content
  }

  const candidates = chunks.length > 0 ? chunks : allChunks;
  const queryEmbedding = await embed(query);

  const scored = candidates.map(c => ({
    chunk_id:      c.chunk_id,
    source_file:   c.source_file,
    section_title: c.section_title,
    category:      c.category,
    chunk_text:    c.chunk_text,
    score: cosineSimilarity(queryEmbedding, c.embedding) + intentBoost(query, c.source_file),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function invalidateCache() {
  chunkCache = null;
  cacheTimestamp = 0;
  console.log("🔄 [Retrieval] Cache invalidated");
}

module.exports = { retrieve, invalidateCache };
