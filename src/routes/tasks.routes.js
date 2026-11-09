/**
 * tasks.routes.js — rep tasks from the owner rule (9 Nov 2026).
 *   GET  /api/tasks/mine            open tasks for the logged-in rep (due first)
 *   POST /api/tasks/:id/done        mark done (her rep or an admin)  body: { note? }
 *   GET  /api/tasks?status=open     admin: everyone's tasks
 */
const express = require("express");
const auth = require("../middleware/auth.middleware");
const sequelize = require("../config/database");

const router = express.Router();

const SELECT = `
  SELECT t.id, t.lead_id, t.rep_id, t.reason, t.urgency, t.title, t.detail,
         t.due_at, t.status, t.notified_at, t.created_at, t.closed_at, t.close_reason,
         (t.status = 'open' AND t.due_at <= UTC_TIMESTAMP()) AS is_due,
         l.name AS lead_name, l.phone AS lead_phone, l.whatsapp_account_id,
         r.name AS rep_name
    FROM rep_tasks t
    JOIN leads l ON l.id = t.lead_id
    LEFT JOIN sales_reps r ON r.id = t.rep_id`;

router.get("/mine", auth, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `${SELECT} WHERE t.rep_id = :rep AND t.status = 'open' ORDER BY t.due_at ASC LIMIT 200`,
      { replacements: { rep: req.user.repId } }
    );
    res.json(rows);
  } catch (err) {
    console.error("[tasks] mine:", err.message);
    res.status(500).json({ error: "Failed to load tasks" });
  }
});

router.post("/:id/done", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [rows] = await sequelize.query("SELECT id, rep_id, status FROM rep_tasks WHERE id = :id", { replacements: { id } });
    const task = rows[0];
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (req.user.role !== "admin" && task.rep_id !== req.user.repId) {
      return res.status(403).json({ error: "Not your task" });
    }
    if (task.status !== "open") return res.json({ ok: true, status: task.status });
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 80) : "done";
    await sequelize.query(
      "UPDATE rep_tasks SET status = 'done', closed_at = NOW(), close_reason = :note WHERE id = :id AND status = 'open'",
      { replacements: { id, note } }
    );
    res.json({ ok: true, status: "done" });
  } catch (err) {
    console.error("[tasks] done:", err.message);
    res.status(500).json({ error: "Failed to update task" });
  }
});

router.get("/", auth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  try {
    const status = ["open", "done", "cancelled"].includes(req.query.status) ? req.query.status : "open";
    const [rows] = await sequelize.query(
      `${SELECT} WHERE t.status = :status ORDER BY t.due_at ASC LIMIT 500`,
      { replacements: { status } }
    );
    res.json(rows);
  } catch (err) {
    console.error("[tasks] list:", err.message);
    res.status(500).json({ error: "Failed to load tasks" });
  }
});

module.exports = router;
