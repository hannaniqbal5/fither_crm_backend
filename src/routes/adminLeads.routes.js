/**
 * adminLeads.routes.js — the admin Leads page (Nov 2026).
 *
 * GET /api/admin/lead-list
 *   q        name, phone (any format), email, Instagram/Facebook name, or #id
 *   source   whatsapp,instagram,facebook,app,ad,…   (comma-separated)
 *   gate     how she came in: whatsapp_inbound, app_signup, number_upload, … ("none" = not recorded)
 *   rep      rep id, or "none" for leads with no rep
 *   stage    visitor,lead,user,churned
 *   plan     none,trial,active,frozen,expired,cancelled
 *   status   new,interested,followup,converted,lost
 *   from,to  created between (YYYY-MM-DD, Pakistan time)
 *   unread   1 = only leads with unread messages
 *   sort     last_message (default) | created | score | name
 *   page, limit (max 200)
 * → { rows, total, page, limit, facets: { source, gate, rep, stage, plan, status } }
 *
 * App leads are included (the old list hid them). Optional columns from later
 * migrations (entry_gate 038, app_phone 036, owner_type 031) are used only
 * when the database has them.
 */
const express = require("express");
const router = express.Router();
const sequelize = require("../config/database");
const auth = require("../middleware/auth.middleware");
const adminOnly = require("../middleware/adminOnly");
const { computeLifecycle } = require("../utils/lifecycle");

let colsCache = null;
async function leadColumns() {
  if (colsCache) return colsCache;
  const [cols] = await sequelize.query("SHOW COLUMNS FROM leads");
  colsCache = new Set(cols.map((c) => c.Field));
  setTimeout(() => { colsCache = null; }, 10 * 60 * 1000).unref?.();
  return colsCache;
}
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const PKT = (ymd, endOfDay) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 5 * 3600e3 + (endOfDay ? 86400e3 : 0));

router.get("/lead-list", auth, adminOnly, async (req, res) => {
  try {
    const has = await leadColumns();
    const opt = (c, alias = c) => (has.has(c) ? `l.${c} AS ${alias}` : `NULL AS ${alias}`);
    const where = ["l.merged_into_lead_id IS NULL"].filter((w) => !/merged/.test(w) || has.has("merged_into_lead_id"));
    const r = {};

    const q = String(req.query.q || "").trim();
    if (q) {
      const idMatch = /^#?(\d{1,9})$/.exec(q);
      const digits = q.replace(/\D/g, "");
      const parts = ["l.name LIKE :like", "l.email LIKE :like"];
      if (has.has("instagram_username")) parts.push("l.instagram_username LIKE :like");
      if (has.has("facebook_name")) parts.push("l.facebook_name LIKE :like");
      if (digits.length >= 4) {
        parts.push("REPLACE(REPLACE(l.phone,' ',''),'+','') LIKE :digits");
        if (has.has("app_phone")) parts.push("l.app_phone LIKE :digits");
        // 0300… finds 92300… and the other way round
        if (digits.length >= 10) { parts.push("RIGHT(REPLACE(REPLACE(l.phone,' ',''),'+',''), 10) = :tail"); r.tail = digits.slice(-10); }
      }
      if (idMatch) { parts.push("l.id = :id"); r.id = Number(idMatch[1]); }
      if (has.has("app_user_id")) { parts.push("l.app_user_id = :q"); r.q = q; }
      where.push(`(${parts.join(" OR ")})`);
      r.like = `%${q}%`;
      r.digits = `%${digits.replace(/^0/, "")}%`;
    }
    const inList = (col, key, vals, nullWord) => {
      if (!vals.length) return;
      const real = vals.filter((v) => v !== nullWord);
      const bits = [];
      if (real.length) { bits.push(`${col} IN (:${key})`); r[key] = real; }
      if (nullWord && vals.includes(nullWord)) bits.push(`${col} IS NULL`);
      where.push(`(${bits.join(" OR ")})`);
    };
    inList("l.source", "source", list(req.query.source));
    if (has.has("entry_gate")) inList("l.entry_gate", "gate", list(req.query.gate), "none");
    inList("l.stage", "stage", list(req.query.stage));
    inList("l.status", "status", list(req.query.status));
    if (has.has("subscription_status")) inList("l.subscription_status", "plan", list(req.query.plan));
    const reps = list(req.query.rep);
    if (reps.length) {
      const ids = reps.filter((x) => x !== "none").map(Number).filter(Boolean);
      const bits = [];
      if (ids.length) { bits.push("l.assigned_to IN (:reps)"); r.reps = ids; }
      if (reps.includes("none")) bits.push("l.assigned_to IS NULL");
      where.push(`(${bits.join(" OR ")})`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "")) { where.push("l.created_at >= :from"); r.from = PKT(req.query.from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "")) { where.push("l.created_at < :to"); r.to = PKT(req.query.to, true); }
    if (req.query.unread === "1") where.push("l.unread_count > 0");

    const sorts = {
      last_message: "COALESCE(l.last_message_at, l.created_at) DESC",
      created: "l.created_at DESC",
      score: "l.lead_score DESC, l.last_message_at DESC",
      name: "l.name IS NULL, l.name ASC",
    };
    const order = sorts[req.query.sort] || sorts.last_message;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    r.limit = limit; r.offset = (page - 1) * limit;
    const W = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await sequelize.query(
      `SELECT l.id, l.name, l.phone, l.email, l.source, l.stage, l.status, l.language, l.lead_score,
              l.unread_count, l.assigned_to, l.whatsapp_account_id, l.last_message_at, l.created_at,
              ${opt("entry_gate")}, ${opt("app_phone")}, ${opt("app_user_id")}, ${opt("instagram_username")},
              ${opt("facebook_name")}, ${opt("interaction_status")}, ${opt("main_goal")},
              ${opt("subscription_status")}, ${opt("subscription_plan_title")}, ${opt("subscription_expires_at")},
              ${opt("owner_type")}, ${opt("last_login_at")}, ${opt("campaign_id")},
              sr.name AS rep_name, wa.phone_number AS wa_number
         FROM leads l
         LEFT JOIN sales_reps sr ON sr.id = l.assigned_to
         LEFT JOIN whatsapp_accounts wa ON wa.id = l.whatsapp_account_id
         ${W}
        ORDER BY ${order}
        LIMIT :limit OFFSET :offset`,
      { replacements: r }
    );
    const [[{ total }]] = await sequelize.query(`SELECT COUNT(*) AS total FROM leads l ${W}`, { replacements: r });

    // Counts for the filter menus (whole CRM, so the menus never empty out)
    const facet = async (col, join = "") => {
      const [f] = await sequelize.query(
        `SELECT ${col} AS value, COUNT(*) AS count FROM leads l ${join}
          ${has.has("merged_into_lead_id") ? "WHERE l.merged_into_lead_id IS NULL" : ""}
          GROUP BY ${col} ORDER BY count DESC`
      );
      return f.map((x) => ({ value: x.value, count: Number(x.count) }));
    };
    const [repFacet] = await sequelize.query(
      `SELECT l.assigned_to AS value, sr.name AS label, COUNT(*) AS count
         FROM leads l LEFT JOIN sales_reps sr ON sr.id = l.assigned_to
         ${has.has("merged_into_lead_id") ? "WHERE l.merged_into_lead_id IS NULL" : ""}
        GROUP BY l.assigned_to, sr.name ORDER BY count DESC`
    );
    const facets = {
      source: await facet("l.source"),
      gate: has.has("entry_gate") ? await facet("l.entry_gate") : [],
      stage: await facet("l.stage"),
      status: await facet("l.status"),
      plan: has.has("subscription_status") ? await facet("l.subscription_status") : [],
      rep: repFacet.map((x) => ({ value: x.value, label: x.label, count: Number(x.count) })),
    };

    res.json({
      rows: rows.map((l) => ({ ...l, lifecycle: computeLifecycle(l) })),
      total: Number(total), page, limit, facets,
    });
  } catch (e) {
    console.error("[lead-list]", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Delete a lead for good (admin) ──────────────────────────────
//   DELETE /api/admin/leads/:id
// Meant for test leads and junk. Removes the lead and every row that points
// at it (messages, Fiza replies, activities, payment requests, …) in one
// transaction. Refuses a lead linked to an app account or with a paid/trial
// plan — those are real customers; unlink or let them expire first.
router.delete("/leads/:id", auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid lead id" });
  try {
    const [[lead]] = await sequelize.query("SELECT * FROM leads WHERE id = :id", { replacements: { id } });
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (lead.app_user_id) {
      return res.status(409).json({ error: "This lead is linked to an app account, so it can't be deleted." });
    }
    if (["active", "trial", "paid"].includes(String(lead.subscription_status || "").toLowerCase())) {
      return res.status(409).json({ error: "This lead has a running plan, so it can't be deleted." });
    }

    // Every column in this database that points at a lead.
    const [refs] = await sequelize.query(
      `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.IS_NULLABLE AS nullable
         FROM information_schema.COLUMNS c
        WHERE c.TABLE_SCHEMA = DATABASE()
          AND c.TABLE_NAME <> 'leads'
          AND c.COLUMN_NAME IN ('lead_id', 'candidate_lead_id')
       UNION
       SELECT k.TABLE_NAME, k.COLUMN_NAME, c.IS_NULLABLE
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.COLUMNS c
           ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME = 'leads'`
    );
    const removed = {};
    await sequelize.transaction(async (transaction) => {
      for (const { t, c, nullable } of refs) {
        if (t === "leads") {
          await sequelize.query(`UPDATE leads SET \`${c}\` = NULL WHERE \`${c}\` = :id`, { replacements: { id }, transaction });
          continue;
        }
        const [r] = await sequelize.query(
          nullable === "YES" && c !== "lead_id"
            ? `UPDATE \`${t}\` SET \`${c}\` = NULL WHERE \`${c}\` = :id`
            : `DELETE FROM \`${t}\` WHERE \`${c}\` = :id`,
          { replacements: { id }, transaction }
        );
        const n = r?.affectedRows ?? 0;
        if (n) removed[`${t}.${c}`] = n;
      }
      // Self-references on leads (e.g. merged_into_lead_id).
      const [selfRefs] = await sequelize.query(
        `SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND REFERENCED_TABLE_NAME = 'leads'`,
        { transaction }
      );
      for (const { c } of selfRefs) {
        await sequelize.query(`UPDATE leads SET \`${c}\` = NULL WHERE \`${c}\` = :id`, { replacements: { id }, transaction });
      }
      await sequelize.query("DELETE FROM leads WHERE id = :id", { replacements: { id }, transaction });
    });

    const io = req.app.get("io");
    if (io) io.to("admins").emit("leadDeleted", { lead_id: id });
    console.log(`🗑 lead #${id} (${lead.phone || "no phone"}) deleted by rep ${req.user?.repId}`, removed);
    res.json({ success: true, lead_id: id, removed });
  } catch (err) {
    console.error("❌ delete lead:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
