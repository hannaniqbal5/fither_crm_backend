const express = require("express");
const auth = require("../middleware/auth.middleware");
const {
  getLeads,
  getMessages,
  sendMessage,
  startChat,
  updateLeadStatus,
  updateDetails,
  getUnreadMessages,
  markLeadAsRead,
} = require("../controllers/leads.controller");

const { People } = require("../../models");
const { assertOwnsOr403 } = require("../middleware/leadOwnership");
const multer = require("multer");
const { sendMediaMessage } = require("../whatsapp/sendMedia");

const router = express.Router();

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ── Media ─────────────────────────────────────────────────────
router.post("/send-media", auth, upload.single("file"), sendMediaMessage);

// ── People list + messages ────────────────────────────────────
router.get("/", auth, getLeads);
router.get("/messages/:leadId", auth, getMessages);
router.post("/send", auth, sendMessage);

// Start a conversation with a number that isn't a contact yet. Open to admins
// and reps: the front desk creates her, the rep who reached out owns her.
router.post("/start-chat", auth, startChat);

// Edit a contact's name / email. Email matters because it's the only key other
// than phone that can connect her to her app account, and nothing on the
// message side ever filled it.
router.patch("/:id/details", auth, updateDetails);

// ── Status update ─────────────────────────────────────────────
router.patch("/:id/status", auth, updateLeadStatus);

// ── Stage update (CRM stage: visitor|lead|user|churned) ───────
router.patch("/:id/stage", auth, async (req, res) => {
  try {
    const { stage } = req.body;
    const allowed = ["visitor", "lead", "user", "churned"];
    if (!allowed.includes(stage)) {
      return res.status(400).json({ message: "Invalid stage" });
    }
    const person = await People.findByPk(req.params.id);
    if (!person) return res.status(404).json({ message: "Person not found" });
    if (!assertOwnsOr403(req, res, person)) return;
    person.stage = stage;
    await person.save();
    res.json({ success: true, stage });
  } catch (err) {
    console.error("Update stage error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── Source update ─────────────────────────────────────────────
router.patch("/:id/source", auth, async (req, res) => {
  try {
    const { source } = req.body;
    const allowed = ["whatsapp", "instagram", "website", "app", "ad", "organic", "referral", "unknown"];
    if (!allowed.includes(source)) {
      return res.status(400).json({ message: "Invalid source" });
    }
    const person = await People.findByPk(req.params.id);
    if (!person) return res.status(404).json({ message: "Person not found" });
    if (!assertOwnsOr403(req, res, person)) return;
    person.source = source;
    await person.save();
    res.json({ success: true, source });
  } catch (err) {
    console.error("Update source error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── Language update (en|ur for bilingual automation) ──────────
router.patch("/:id/language", auth, async (req, res) => {
  try {
    const { language } = req.body;
    if (!["en", "ur"].includes(language)) {
      return res.status(400).json({ message: "Invalid language. Use en or ur" });
    }
    const person = await People.findByPk(req.params.id);
    if (!person) return res.status(404).json({ message: "Person not found" });
    if (!assertOwnsOr403(req, res, person)) return;
    person.language = language;
    await person.save();
    res.json({ success: true, language });
  } catch (err) {
    console.error("Update language error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── Notes update ──────────────────────────────────────────────
router.patch("/:id/notes", auth, async (req, res) => {
  try {
    const { notes } = req.body;
    const person = await People.findByPk(req.params.id);
    if (!person) return res.status(404).json({ message: "Person not found" });
    if (!assertOwnsOr403(req, res, person)) return;
    person.notes = notes;
    await person.save();
    res.json({ success: true });
  } catch (err) {
    console.error("Update notes error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── Unread / mark read ────────────────────────────────────────
router.get("/unread", auth, getUnreadMessages);
router.put("/mark-read/:leadId", auth, markLeadAsRead);

module.exports = router;
