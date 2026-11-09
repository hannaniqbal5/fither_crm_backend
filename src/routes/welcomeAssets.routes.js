/**
 * welcomeAssets.routes.js — Phase 15a admin endpoints.
 *
 *   GET    /api/welcome-assets                     — list all assets
 *   GET    /api/welcome-assets/active              — current active voice + poster
 *   POST   /api/welcome-assets/upload              — multipart: file + asset_type + language + caption
 *   PATCH  /api/welcome-assets/:id                 — update caption / language
 *   POST   /api/welcome-assets/:id/activate        — set as active (auto-deactivates prior)
 *   DELETE /api/welcome-assets/:id                 — remove asset + file
 *   GET    /api/welcome-assets/file/:fileName      — public file serve (used by Baileys when sending)
 */

const express = require("express");
const router  = express.Router();
const multer  = require("multer");
const path    = require("path");
const fsSync  = require("fs");
const sequelize = require("../config/database");
const { WELCOME_DIR, ensureUploadDir, activateAsset } = require("../services/welcomeAssets.service");
const auth = require("../middleware/auth.middleware");
const adminOnly      = require("../middleware/adminOnly");

// ── Public file serve (Baileys downloads this when sending) ───
// Must stay public and be registered BEFORE the admin guard below.
router.get("/file/:fileName", (req, res) => {
  const safeName = path.basename(req.params.fileName);
  const fullPath = path.join(WELCOME_DIR, safeName);
  if (!fsSync.existsSync(fullPath)) return res.status(404).end();
  res.sendFile(fullPath);
});

// Admin-only: every endpoint below requires an authenticated admin.
router.use(auth, adminOnly);

// ── Allowed mime types per asset type → server-chosen file extension ──
// The saved extension comes from this map, never from the client filename.
const ALLOWED = {
  voice: {
    "audio/mpeg": ".mp3",
    "audio/mp3":  ".mp3",
    "audio/ogg":  ".ogg",
    "audio/opus": ".opus",
    "audio/wav":  ".wav",
    "audio/wave": ".wav",
    "audio/aac":  ".aac",
    "audio/webm": ".webm",
  },
  poster: {
    "image/jpeg": ".jpg",
    "image/png":  ".png",
    "image/gif":  ".gif",
    "image/webp": ".webp",
  },
};

function normMime(m) {
  return String(m || "").split(";")[0].trim().toLowerCase();
}

function extForMime(mime) {
  const m = normMime(mime);
  return ALLOWED.voice[m] || ALLOWED.poster[m] || null;
}

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  e.publicMessage = msg;
  return e;
}

// ── Multer config ─────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureUploadDir();
    cb(null, WELCOME_DIR);
  },
  filename: (req, file, cb) => {
    const ext = extForMime(file.mimetype); // already validated in fileFilter
    if (!ext) return cb(badRequest(`Invalid mime ${normMime(file.mimetype)}`));
    const ts = Date.now();
    const base = path.parse(String(file.originalname || "file")).name
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 80) || "file";
    cb(null, `${ts}_${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (req, file, cb) => {
    const assetType = req.body?.asset_type || req.query?.asset_type;
    if (!assetType || !Object.prototype.hasOwnProperty.call(ALLOWED, assetType)) {
      return cb(badRequest("asset_type must be 'voice' or 'poster'"));
    }
    if (!ALLOWED[assetType][normMime(file.mimetype)]) {
      return cb(badRequest(`Invalid mime ${normMime(file.mimetype)} for asset_type ${assetType}`));
    }
    cb(null, true);
  },
});

// ── List all assets ───────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT id, asset_type, language, file_name, mime_type, file_size, caption,
              is_active, uploaded_by, created_at
         FROM welcome_assets
         ORDER BY asset_type ASC, is_active DESC, created_at DESC`
    );
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Current active voice + poster ─────────────────────────────
router.get("/active", async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT id, asset_type, language, file_name, caption, file_size
         FROM welcome_assets WHERE is_active = 1`
    );
    const active = { voice: null, poster: null };
    rows.forEach(r => {
      if (r.asset_type === "voice")  active.voice  = r;
      if (r.asset_type === "poster") active.poster = r;
    });
    res.json(active);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Upload a new asset ────────────────────────────────────────
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { asset_type, language = "both", caption = null, activate_now } = req.body;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (!["voice","poster"].includes(asset_type))
      return res.status(400).json({ error: "asset_type must be voice or poster" });
    if (!["ur","en","both"].includes(language))
      return res.status(400).json({ error: "language must be ur, en, or both" });

    const filePath = `/uploads/welcome/${req.file.filename}`;
    const [result] = await sequelize.query(
      `INSERT INTO welcome_assets
         (asset_type, language, file_name, file_path, mime_type, file_size, caption, is_active, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          asset_type, language, req.file.filename, filePath,
          req.file.mimetype, req.file.size, caption,
          activate_now === "true" || activate_now === true ? 1 : 0,
          req.user?.repId || null,
        ],
      }
    );
    const insertId = require("../utils/insertId").insertIdOf(result);

    // If activated, deactivate others of same (type, language)
    if (activate_now === "true" || activate_now === true) {
      await activateAsset(insertId);
    }

    res.json({ ok: true, id: insertId, file_path: filePath });
  } catch (err) {
    console.error("[welcomeAssets/upload]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Update caption / language ─────────────────────────────────
router.patch("/:id", async (req, res) => {
  try {
    const { caption, language } = req.body;
    const sets = [];
    const repls = [];
    if (caption !== undefined) { sets.push("caption = ?"); repls.push(caption); }
    if (language !== undefined) {
      if (!["ur","en","both"].includes(language)) return res.status(400).json({ error: "Invalid language" });
      sets.push("language = ?"); repls.push(language);
    }
    if (!sets.length) return res.json({ ok: true, noop: true });
    repls.push(req.params.id);
    await sequelize.query(
      `UPDATE welcome_assets SET ${sets.join(", ")} WHERE id = ?`,
      { replacements: repls }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Activate an asset ─────────────────────────────────────────
router.post("/:id/activate", async (req, res) => {
  try {
    await activateAsset(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete an asset ───────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      "SELECT file_name FROM welcome_assets WHERE id = ?",
      { replacements: [req.params.id] }
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });

    await sequelize.query("DELETE FROM welcome_assets WHERE id = ?", { replacements: [req.params.id] });

    const fullPath = path.join(WELCOME_DIR, rows[0].file_name);
    try { fsSync.unlinkSync(fullPath); } catch {}

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
