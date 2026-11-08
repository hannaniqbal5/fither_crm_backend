/**
 * ingest.script.js — read /new.md/, chunk by H2 sections, embed via Gemini, store in kb_chunks.
 *
 * Usage:
 *   npm run ai:ingest
 *
 * Re-run any time you edit a knowledge file. The script:
 *   - DELETEs existing kb_chunks (clean rebuild)
 *   - reads every .md file in AI_KB_PATH
 *   - splits each file into sections by ## headers
 *   - embeds each section via Gemini text-embedding-004
 *   - inserts into kb_chunks with source_file + section_title
 *   - invalidates the in-process cache (next reply uses fresh data)
 *
 * Defaults to AI_KB_PATH=../new.md (relative to this backend's package root).
 */

require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { embed } = require("./embedding.service");
const sequelize = require("../config/database");
const { invalidateCache } = require("./retrieval.service");
const { categorize } = require("./kb.categories");

const KB_REL_PATH = process.env.AI_KB_PATH || "../new.md";
const KB_DIR = path.resolve(__dirname, "../../", KB_REL_PATH);

const MIN_CHUNK_LENGTH = 100; // skip tiny sections (frontmatter, blank intros)

/**
 * Split a markdown file into sections by H2 (##) headers.
 * Pre-condition: knowledge files are authored with ## section structure.
 */
function chunkBySection(content) {
  // Drop YAML frontmatter if present
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, "");

  const sections = stripped.split(/\n(?=##\s)/);
  return sections
    .map(s => s.trim())
    .filter(s => s.length >= MIN_CHUNK_LENGTH)
    .map(s => {
      const titleMatch = s.match(/^##\s+(.+?)(\n|$)/);
      return {
        title: titleMatch ? titleMatch[1].trim() : "Intro",
        text:  s,
      };
    });
}

async function ingest() {
  console.log(`\n📚 [Ingest] FitHer knowledge base ingestion starting`);
  console.log(`📁 [Ingest] Source: ${KB_DIR}`);

  let files;
  try {
    files = (await fs.readdir(KB_DIR)).filter(f => f.endsWith(".md"));
  } catch (err) {
    console.error(`❌ [Ingest] Cannot read KB folder: ${KB_DIR}`);
    console.error(`   ${err.message}`);
    console.error(`   Hint: set AI_KB_PATH in .env to the relative path of the new.md folder`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`❌ [Ingest] No .md files found in ${KB_DIR}`);
    process.exit(1);
  }

  console.log(`📄 [Ingest] Found ${files.length} markdown file(s):\n   ${files.join("\n   ")}`);

  await sequelize.query("DELETE FROM kb_chunks");
  console.log(`🧹 [Ingest] Cleared existing kb_chunks rows`);

  let totalChunks = 0;
  let totalErrors = 0;

  for (const file of files) {
    const fullPath = path.join(KB_DIR, file);
    const content = await fs.readFile(fullPath, "utf-8");
    const chunks = chunkBySection(content);

    console.log(`\n📑 ${file} → ${chunks.length} section(s)`);

    for (const chunk of chunks) {
      try {
        const embedding = await embed(chunk.text);
        const category  = categorize(file, chunk.title);

        await sequelize.query(
          `INSERT INTO kb_chunks
             (chunk_id, source_file, section_title, category, chunk_text, embedding, token_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          {
            replacements: [
              uuidv4(),
              file,
              chunk.title.slice(0, 250),
              category,
              chunk.text,
              JSON.stringify(embedding),
              Math.ceil(chunk.text.length / 4),
            ],
          }
        );
        totalChunks++;
        console.log(`   ✅ ${chunk.title}  [${category}]`);
      } catch (err) {
        totalErrors++;
        console.error(`   ❌ ${chunk.title}: ${err.message}`);
      }
    }
  }

  invalidateCache();

  console.log(`\n=========================================`);
  console.log(`✅ [Ingest] DONE`);
  console.log(`   Files processed:  ${files.length}`);
  console.log(`   Chunks ingested:  ${totalChunks}`);
  console.log(`   Errors:           ${totalErrors}`);
  console.log(`=========================================\n`);

  if (totalErrors > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  ingest()
    .then(() => process.exit(0))
    .catch(err => {
      console.error("❌ [Ingest] Fatal error:", err);
      process.exit(1);
    });
}

module.exports = { ingest };
