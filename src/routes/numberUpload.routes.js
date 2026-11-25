/**
 * numberUpload.routes.js — Number upload & management system.
 *
 * Upload Excel/CSV files of phone numbers, categorise as paid/unpaid,
 * and use them for WhatsApp campaigns.
 *
 *   POST   /api/number-batches/upload         — upload a file → create batch + entries
 *   GET    /api/number-batches                — list all batches
 *   GET    /api/number-batches/stats          — overall stats (total paid/unpaid)
 *   GET    /api/number-batches/:id            — batch detail
 *   PATCH  /api/number-batches/:id            — update batch name/notes
 *   DELETE /api/number-batches/:id            — delete batch + entries
 *   GET    /api/number-batches/:id/entries    — paginated entries in a batch
 *   PATCH  /api/number-entries/:id/category   — change single entry's category
 *   PATCH  /api/number-batches/:id/bulk-category — change category for all entries in batch
 *   GET    /api/number-entries/search         — search by phone across all batches
 *   POST   /api/number-batches/:id/to-campaign — push numbers to a campaign as recipients
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const auth = require("../middleware/auth.middleware");
const sequelize = require("../config/database");
const { NumberBatch, NumberEntry } = require("../../models");
const { parseSpreadsheet } = require("../utils/xlsxParser");

const router = express.Router();

const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
};

// ── Multer config (store in uploads/numbers/) ─────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../../uploads/numbers");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${ts}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls", ".csv", ".tsv"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only .xlsx, .csv, and .tsv files are allowed"));
    }
  },
});

// ── Helper: clean phone number ────────────────────────────────
function cleanPhone(raw) {
  if (!raw) return null;
  // Remove everything except digits and leading +
  let phone = String(raw).trim();
  // Remove common formatting
  phone = phone.replace(/[\s\-\(\)\.]/g, "");
  // Must have at least 7 digits
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return phone;
}

function phoneLast10(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

// ── Helper: detect phone column in header row ─────────────────
function findPhoneCol(headers) {
  const phonePatterns = [
    /^phone$/i, /^phone.?number$/i, /^mobile$/i, /^cell$/i, /^raw.?phone$/i,
    /^contact$/i, /^number$/i, /^whatsapp$/i, /^wa.?number$/i, /whatsapp.?number/i, /phone/i, /mobile/i,
    /^tel$/i, /^telephone$/i,
  ];
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i]).trim();
    if (phonePatterns.some((p) => p.test(h))) return i;
  }
  // Fallback: first column that looks like it has phone numbers
  return -1; // caller will try first column
}

function findNameCol(headers) {
  const patterns = [/^name$/i, /^full.?name$/i, /^client.?name$/i, /^customer$/i];
  for (let i = 0; i < headers.length; i++) {
    if (patterns.some((p) => p.test(String(headers[i]).trim()))) return i;
  }
  return -1;
}

function findCategoryCol(headers) {
  const patterns = [/^category$/i, /^paid$/i, /^paid.?converted$/i, /^status$/i, /^type$/i];
  for (let i = 0; i < headers.length; i++) {
    if (patterns.some((p) => p.test(String(headers[i]).trim()))) return i;
  }
  return -1;
}

// ── POST /api/number-batches/upload ───────────────────────────
router.post("/number-batches/upload", auth, adminOnly, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { name, category = "unpaid", notes } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Batch name is required" });
    }
    if (!["paid", "unpaid"].includes(category)) {
      return res.status(400).json({ error: "Category must be paid or unpaid" });
    }

    // Parse the spreadsheet
    let rows;
    try {
      rows = parseSpreadsheet(req.file.path);
    } catch (parseErr) {
      return res.status(400).json({ error: `Failed to parse file: ${parseErr.message}` });
    }

    if (!rows || rows.length < 1) {
      return res.status(400).json({ error: "File is empty" });
    }

    // Detect headers vs data
    const firstRow = rows[0];
    const hasHeader = firstRow.some((cell) =>
      /^(phone|name|number|mobile|contact|email|whatsapp|status|raw|date|city|amount|package|age|weight|goal|source|paid|category)/i.test(String(cell).trim())
    );

    const headers = hasHeader ? firstRow.map((h) => String(h).trim()) : [];
    const dataRows = hasHeader ? rows.slice(1) : rows;

    const phoneColIdx = hasHeader ? findPhoneCol(headers) : -1;
    const nameColIdx = hasHeader ? findNameCol(headers) : -1;
    const categoryColIdx = hasHeader ? findCategoryCol(headers) : -1;
    const usePhoneCol = phoneColIdx >= 0 ? phoneColIdx : 0; // default to first column

    // Create the batch
    const batch = await NumberBatch.create({
      name: name.trim(),
      category,
      original_file: req.file.originalname,
      notes: notes || null,
      created_by: req.user.repId,
    });

    // Process entries
    const entries = [];
    const seenPhones = new Set();
    let skipped = 0;

    for (const row of dataRows) {
      const rawPhone = row[usePhoneCol];
      const phone = cleanPhone(rawPhone);
      if (!phone) { skipped++; continue; }

      const last10 = phoneLast10(phone);
      if (seenPhones.has(last10)) { skipped++; continue; } // dedup within file
      seenPhones.add(last10);

      const entryName = nameColIdx >= 0 ? (row[nameColIdx] || "").trim() || null : null;

      // Per-row category: if file has a Category column, use it
      let rowCategory = category; // default to batch-level
      if (categoryColIdx >= 0) {
        const catVal = String(row[categoryColIdx] || "").trim().toLowerCase();
        if (catVal === "paid" || catVal === "yes" || catVal === "converted") {
          rowCategory = "paid";
        } else if (catVal === "unpaid" || catVal === "no" || catVal === "") {
          rowCategory = "unpaid";
        }
      }

      // Collect extra data from other columns
      let extraData = null;
      if (hasHeader && headers.length > 0) {
        const extra = {};
        headers.forEach((h, idx) => {
          if (idx === usePhoneCol || idx === nameColIdx) return;
          if (row[idx] && String(row[idx]).trim()) {
            extra[h] = String(row[idx]).trim();
          }
        });
        if (Object.keys(extra).length > 0) extraData = extra;
      }

      entries.push({
        batch_id: batch.id,
        phone,
        phone_last10: last10,
        name: entryName,
        category: rowCategory,
        extra_data: extraData,
      });
    }

    // Bulk insert in chunks to avoid max_allowed_packet
    if (entries.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < entries.length; i += CHUNK) {
        await NumberEntry.bulkCreate(entries.slice(i, i + CHUNK), { validate: false });
      }
    }

    // Update batch counts
    const paidCount = entries.filter(e => e.category === "paid").length;
    const unpaidCount = entries.filter(e => e.category === "unpaid").length;


    await batch.update({
      total_numbers: entries.length,
      paid_count: paidCount,
      unpaid_count: unpaidCount,
    });

    res.status(201).json({
      success: true,
      batch: {
        id: batch.id,
        name: batch.name,
        category,
        total_numbers: entries.length,
        paid_count: paidCount,
        unpaid_count: unpaidCount,
        skipped,
        original_file: req.file.originalname,
      },
    });
  } catch (err) {
    console.error("❌ [number-upload]:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/number-batches ──────────────────────────────────
router.get("/number-batches", auth, adminOnly, async (req, res) => {
  try {
    const batches = await NumberBatch.findAll({
      order: [["created_at", "DESC"]],
      limit: 100,
    });
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/number-batches/stats ────────────────────────────
router.get("/number-batches/stats", auth, adminOnly, async (req, res) => {
  try {
    const [[totals]] = await sequelize.query(
      `SELECT
         COUNT(DISTINCT nb.id) AS total_batches,
         COALESCE(SUM(nb.total_numbers), 0) AS total_numbers,
         COALESCE(SUM(nb.paid_count), 0) AS total_paid,
         COALESCE(SUM(nb.unpaid_count), 0) AS total_unpaid
       FROM number_batches nb`
    );
    res.json(totals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/number-batches/:id ──────────────────────────────
router.get("/number-batches/:id", auth, adminOnly, async (req, res) => {
  try {
    const batch = await NumberBatch.findByPk(req.params.id);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    res.json(batch);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/number-batches/:id ────────────────────────────
router.patch("/number-batches/:id", auth, adminOnly, async (req, res) => {
  try {
    const batch = await NumberBatch.findByPk(req.params.id);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    const { name, notes } = req.body;
    if (name) batch.name = name.trim();
    if (notes !== undefined) batch.notes = notes;
    await batch.save();
    res.json(batch);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/number-batches/:id ───────────────────────────
router.delete("/number-batches/:id", auth, adminOnly, async (req, res) => {
  try {
    const batch = await NumberBatch.findByPk(req.params.id);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    await batch.destroy(); // CASCADE deletes entries
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/number-batches/:id/entries ──────────────────────
router.get("/number-batches/:id/entries", auth, adminOnly, async (req, res) => {
  try {
    const { category, page = 1, limit = 50 } = req.query;
    const where = { batch_id: req.params.id };
    if (category && ["paid", "unpaid"].includes(category)) {
      where.category = category;
    }

    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const { count, rows } = await NumberEntry.findAndCountAll({
      where,
      order: [["id", "ASC"]],
      limit: Math.min(parseInt(limit) || 50, 200),
      offset,
    });
    res.json({ total: count, page: parseInt(page), entries: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/number-entries/:id/category ───────────────────
router.patch("/number-entries/:id/category", auth, adminOnly, async (req, res) => {
  try {
    const entry = await NumberEntry.findByPk(req.params.id);
    if (!entry) return res.status(404).json({ error: "Entry not found" });

    const { category } = req.body;
    if (!["paid", "unpaid"].includes(category)) {
      return res.status(400).json({ error: "Category must be paid or unpaid" });
    }

    const oldCat = entry.category;
    if (oldCat === category) return res.json(entry);

    entry.category = category;
    await entry.save();

    // Update batch counts
    const batch = await NumberBatch.findByPk(entry.batch_id);
    if (batch) {
      if (oldCat === "paid") batch.paid_count = Math.max(0, batch.paid_count - 1);
      if (oldCat === "unpaid") batch.unpaid_count = Math.max(0, batch.unpaid_count - 1);
      if (category === "paid") batch.paid_count += 1;
      if (category === "unpaid") batch.unpaid_count += 1;
      await batch.save();
    }

    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/number-batches/:id/bulk-category ─────────────
router.patch("/number-batches/:id/bulk-category", auth, adminOnly, async (req, res) => {
  try {
    const batch = await NumberBatch.findByPk(req.params.id);
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    const { category } = req.body;
    if (!["paid", "unpaid"].includes(category)) {
      return res.status(400).json({ error: "Category must be paid or unpaid" });
    }

    await NumberEntry.update(
      { category },
      { where: { batch_id: batch.id } }
    );

    batch.category = category;
    batch.paid_count = category === "paid" ? batch.total_numbers : 0;
    batch.unpaid_count = category === "unpaid" ? batch.total_numbers : 0;
    await batch.save();

    res.json({ success: true, batch });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/number-entries/search ───────────────────────────
router.get("/number-entries/search", auth, adminOnly, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 4) {
      return res.status(400).json({ error: "Search query must be at least 4 characters" });
    }
    const digits = q.replace(/\D/g, "");
    if (digits.length < 4) {
      return res.status(400).json({ error: "Need at least 4 digits to search" });
    }

    const [rows] = await sequelize.query(
      `SELECT ne.*, nb.name AS batch_name
         FROM number_entries ne
         JOIN number_batches nb ON nb.id = ne.batch_id
        WHERE ne.phone_last10 LIKE :pattern
        ORDER BY ne.created_at DESC
        LIMIT 50`,
      { replacements: { pattern: `%${digits.slice(-10)}%` } }
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/number-batches/:id/to-campaign ─────────────────
// Push numbers from a batch (optionally filtered by category) into
// an existing campaign's recipients. Numbers are matched/created in
// the leads table first so campaign_recipients has valid lead_ids.
router.post("/number-batches/:id/to-campaign", auth, adminOnly, async (req, res) => {
  try {
    const { campaign_id, category } = req.body;
    if (!campaign_id) return res.status(400).json({ error: "campaign_id is required" });

    // Verify campaign exists and is a draft
    const [[campaign]] = await sequelize.query(
      `SELECT campaign_id, status, assigned_rep_id FROM campaigns WHERE campaign_id = :cid LIMIT 1`,
      { replacements: { cid: campaign_id } }
    );
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status !== "draft") {
      return res.status(400).json({ error: "Can only add recipients to draft campaigns" });
    }

    // Get entries from batch
    const where = { batch_id: req.params.id };
    if (category && ["paid", "unpaid"].includes(category)) {
      where.category = category;
    }
    const entries = await NumberEntry.findAll({ where, attributes: ["phone", "phone_last10", "name"] });

    if (entries.length === 0) {
      return res.json({ success: true, added: 0, message: "No entries to add" });
    }

    let addedCount = 0;
    for (const entry of entries) {
      // One door in. The front desk does the same last-10-digit match this
      // route invented, and it also gives her an owner — the minimal insert
      // here left assigned_to NULL, so an uploaded number was invisible to
      // every rep until she happened to reply.
      const frontDesk = require("../services/frontDesk");
      // A campaign with a rep gives new numbers to THAT rep (same rule as a
      // group import), so "Same as rep" follows the campaign's rep. No rep on
      // the campaign → round robin as before.
      const campaignRep = campaign.assigned_rep_id || null;
      const { contact: uploaded, isNew: uploadedIsNew } = await frontDesk.findOrCreateContact({
        channel:    "phone",
        phone:      entry.phone,
        name:       entry.name || null,
        loosePhone: true,
        source:     "whatsapp",
        gate:       "number_upload",
        repId:      campaignRep,
      });
      const leadId = uploaded.id;
      // Someone we already knew keeps her existing rep — never clobbered.
      // Only an unowned one is given to the campaign's rep.
      if (!uploadedIsNew && campaignRep) {
        await sequelize.query(
          "UPDATE leads SET assigned_to = :rep WHERE id = :id AND assigned_to IS NULL",
          { replacements: { rep: campaignRep, id: leadId } }
        );
      }

      // Add to campaign recipients (ignore duplicates)
      try {
        await sequelize.query(
          `INSERT IGNORE INTO campaign_recipients (campaign_id, lead_id) VALUES (:cid, :lid)`,
          { replacements: { cid: campaign_id, lid: leadId } }
        );
        addedCount++;
      } catch (dupErr) {
        // ignore duplicates
      }
    }

    // Update campaign total
    await sequelize.query(
      `UPDATE campaigns
          SET total_recipients = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = :cid)
        WHERE campaign_id = :cid`,
      { replacements: { cid: campaign_id } }
    );

    res.json({ success: true, added: addedCount, total_entries: entries.length });
  } catch (err) {
    console.error("❌ [to-campaign]:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
