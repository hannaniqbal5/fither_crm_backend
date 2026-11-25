/**
 * owner.service.js — the owner rule (9 Nov 2026, journey-architecture.md §2–3).
 *
 *   Rule 1: every woman always has exactly one owner — a rep or Fiza.
 *   Rule 2: a human steps in only when there's a reason (a "stuck" signal).
 *
 * escalate(leadId, reason, ctx)  — a stuck signal arrived:
 *   • opted out / DNC          → nothing.
 *   • paying, sales reason     → nothing (sales stops after payment).
 *   • has an active rep        → keep her rep.
 *   • no rep, has a phone      → round robin across ALL active reps; her
 *                                 WhatsApp number becomes her rep's number,
 *                                 so the rep's inbox shows her.
 *   • no phone                 → owner = Fiza; ask her once, by app push, to
 *                                 share her WhatsApp in Help & Support.
 *   Then one open task per lead + reason, due per the ladder (push first,
 *   human second): normal = 24 h after the app's own push (or now if the app
 *   can't reach her); hot = within the hour. The rep is pushed when it's due.
 *
 * resolve(leadId, reasons, why)  — she moved forward: close those tasks.
 * onPhoneAdded(leadId)           — Fiza got her number: hand open reasons to a rep.
 * tick()                         — every 5 min: push due tasks; move tasks off
 *                                   deactivated reps.
 */
const sequelize = require("../config/database");
const { sqlUtc } = require("../utils/sqlTime");

const HOUR = 3600 * 1000;

// Ladder per reason. waitAfterAppPushH: how long after the app's own push the
// rep should act (normal reasons). dueInMin: hot reasons.
const REASONS = {
  // Nov 2026: she asked for a person in the app / web chat with Fiza, or Fiza
  // could not / should not answer (health, emotions, payments problem).
  chat_handoff: {
    urgency: "hot",
    dueInMin: 15,
    retention: true,
    title: (l) => `${l.name || "She"} needs a coach in the app chat`,
    detail: (l, c) => `${c.why ? "Why: " + c.why + ". " : ""}Reply in her chat — it goes to her app.`,
  },
  onboarding_stalled: {
    urgency: "normal",
    waitAfterAppPushH: 24,
    title: (l, c) => `Help ${l.name || "her"} finish sign-up`,
    detail: (l, c) => `Stopped at question ${c.step ?? "?"} of ${c.total || 6} in the app.${c.appPushedAt ? " The app reminded her already." : ""} Ask if anything is unclear.`,
  },
  trial_no_class: {
    urgency: "normal",
    waitAfterAppPushH: 10,
    title: (l) => `${l.name || "She"} hasn't joined a trial class`,
    detail: (l, c) => `Trial day ${c.trialDay ?? "?"}, no class yet. Ask what's stopping her: timing, shyness, how to join.`,
  },
  payment_dropped: {
    urgency: "hot",
    dueInMin: 90,
    title: (l) => `${l.name || "She"} started paying and stopped`,
    detail: (l, c) => `${c.plan ? c.plan + ". " : ""}She wanted to buy. Help her finish the payment.`,
  },
  slip_rejected: {
    urgency: "hot",
    dueInMin: 30,
    title: (l) => `${l.name || "Her"} payment slip was rejected`,
    detail: (l, c) => `${c.why ? "Reason: " + c.why + ". " : ""}Help her send a correct slip.`,
  },
  payment_paused: {
    urgency: "hot",
    dueInMin: 120,
    title: (l) => `${l.name || "Her"} plan is paused: payment not confirmed`,
    detail: () => "Check the payment with her and ask for proof.",
  },
  subscription_frozen: {
    urgency: "hot",
    dueInMin: 60,
    retention: true,
    title: (l) => `${l.name || "Customer"} froze her subscription`,
    detail: (l, c) => `She paused her plan${c.freeze_days ? " for " + c.freeze_days + " days" : ""}. Find out why and see if you can help.`,
  },
  retention_risk: {
    urgency: "normal",
    waitAfterAppPushH: 24,
    retention: true,
    title: (l) => `Check in with ${l.name || "customer"}`,
    detail: (l, c) => c.why || "Going quiet, renewal due or payment failed.",
  },
  // Auto-takeover (services/autoTakeover.service.js). retention: true so they
  // also reach paying members and aren't auto-closed as "sales" tasks.
  ai_takeover_nudge: {
    urgency: "hot",
    dueInMin: 15,
    retention: true,
    title: (l) => `${l.name || "She"} is waiting for a reply`,
    detail: (l, c) => `No reply for ${c.minutes ?? "a while"} min. Answer her on WhatsApp.`,
  },
  ai_auto_replied: {
    urgency: "hot",
    dueInMin: 60,
    retention: true,
    title: (l) => `Fizza replied to ${l.name || "her"} while you were away`,
    detail: (l, c) => `${c.why === "low_confidence" ? "Fizza wasn't sure, so she only said you'll reply. " : ""}Read the chat and follow up.`,
  },
  ai_takeover_flagged: {
    urgency: "hot",
    dueInMin: 15,
    retention: true,
    title: (l) => `${l.name || "She"} needs you, not Fizza`,
    detail: (l, c) => `Waiting ${c.minutes ?? "?"} min. Fizza held back: ${c.why || "sensitive"}. Reply on WhatsApp.`,
  },
};
const SALES_REASONS = Object.keys(REASONS).filter((r) => !REASONS[r].retention);

async function one(sql, replacements) {
  const [rows] = await sequelize.query(sql, { replacements });
  return rows[0] || null;
}

async function isBlocked(lead) {
  if (lead.interaction_status === "opted_out") return true;
  try {
    const hit = await one(
      "SELECT id FROM dnc_list WHERE lead_id = :id OR (phone IS NOT NULL AND phone = :phone) LIMIT 1",
      { id: lead.id, phone: lead.phone || "__none__" }
    );
    return !!hit;
  } catch (_) {
    return false; // dnc_list missing on an old DB: don't block
  }
}

async function activeRep(repId) {
  if (!repId) return null;
  return one("SELECT id, name, whatsapp_account_id FROM sales_reps WHERE id = :id AND status = 'active'", { id: repId });
}

async function writeActivity(leadId, type, data) {
  try {
    await require("./activity.service").writeActivity(leadId, type, "crm", data);
  } catch (e) {
    console.error(`[owner] activity ${type} failed:`, e.message);
  }
}

/** Give her a rep (keep the current active one, else round robin). */
async function ensureRep(lead) {
  const current = await activeRep(lead.assigned_to);
  if (current) {
    if (lead.owner_type !== "rep") {
      await sequelize.query("UPDATE leads SET owner_type = 'rep', owner_assigned_at = NOW() WHERE id = :id", { replacements: { id: lead.id } });
    }
    return current;
  }
  const { getNextRepRoundRobin } = require("./assignment.service");
  const rep = await getNextRepRoundRobin(null); // all active reps, every number
  if (!rep) return null;
  await sequelize.query(
    `UPDATE leads
        SET assigned_to = :rep, whatsapp_account_id = COALESCE(:acct, whatsapp_account_id),
            owner_type = 'rep', owner_assigned_at = NOW()
      WHERE id = :id`,
    { replacements: { id: lead.id, rep: rep.id, acct: rep.whatsapp_account_id || null } }
  );
  await writeActivity(lead.id, "owner_assigned", { rep_id: rep.id, owner: "rep" });
  return rep;
}

/** No phone: Fiza asks her once, by app push, for her WhatsApp number. */
async function askForPhone(lead, reason) {
  await sequelize.query(
    "UPDATE leads SET owner_type = 'fiza', owner_reason = :reason, owner_assigned_at = COALESCE(owner_assigned_at, NOW()) WHERE id = :id",
    { replacements: { id: lead.id, reason } }
  );
  if (lead.phone_requested_at || !lead.app_user_id) return false;
  const { pushToApp } = require("./appPush");
  const push = await pushToApp({
    appUserId: lead.app_user_id,
    title: "Want a coach to help you? 💚",
    body: "Share your WhatsApp number in Help & Support and your Fit Her coach will message you.",
    data: { type: "coach_phone_request", lead_id: String(lead.id) },
  });
  if (push.pushed) {
    await sequelize.query("UPDATE leads SET phone_requested_at = NOW() WHERE id = :id", { replacements: { id: lead.id } });
    await writeActivity(lead.id, "phone_requested", { via: "app_push" });
    return true;
  }
  if (!["not_configured", "outbound_disabled"].includes(push.reason)) {
    console.error("[owner] phone request push not sent:", push.reason);
  }
  return false;
}

function dueAt(reason, ctx) {
  const cfg = REASONS[reason];
  if (cfg.urgency === "hot") return new Date(Date.now() + (cfg.dueInMin || 60) * 60000);
  // Normal: push first, human second. If the app pushed her, wait; if the
  // app can't reach her (no device), the rep acts now.
  if (ctx.canPush === false) return new Date();
  const base = ctx.appPushedAt ? new Date(ctx.appPushedAt) : new Date();
  const due = new Date(base.getTime() + (cfg.waitAfterAppPushH || 24) * HOUR);
  return due < new Date() ? new Date() : due;
}

/**
 * escalate — a stuck signal for this lead.
 * @returns {Promise<{action: string, taskId?: number, repId?: number}>}
 */
async function escalate(leadId, reason, ctx = {}) {
  const cfg = REASONS[reason];
  if (!cfg) throw new Error(`Unknown owner reason: ${reason}`);
  const lead = await one("SELECT * FROM leads WHERE id = :id", { id: leadId });
  if (!lead) return { action: "no_lead" };
  if (await isBlocked(lead)) return { action: "blocked_opted_out" };
  const paying = ["active", "frozen"].includes(lead.subscription_status);
  if (paying && !cfg.retention) return { action: "skipped_paying" };

  if (!lead.phone) {
    const asked = await askForPhone(lead, reason);
    return { action: asked ? "fiza_asked_phone" : "fiza_owner" };
  }

  const rep = await ensureRep(lead);
  if (!rep) {
    console.warn(`[owner] no active rep for lead ${leadId} (${reason})`);
    return { action: "no_active_rep" };
  }

  const open = await one(
    "SELECT id FROM rep_tasks WHERE lead_id = :id AND reason = :reason AND status = 'open' LIMIT 1",
    { id: leadId, reason }
  );
  if (open) return { action: "task_exists", taskId: open.id, repId: rep.id };

  const due = dueAt(reason, ctx);
  const [ins] = await sequelize.query(
    `INSERT INTO rep_tasks (lead_id, rep_id, reason, urgency, title, detail, due_at)
     VALUES (:lead, :rep, :reason, :urgency, :title, :detail, :due)`,
    {
      replacements: {
        lead: leadId,
        rep: rep.id,
        reason,
        urgency: cfg.urgency,
        title: cfg.title(lead, ctx).slice(0, 200),
        detail: cfg.detail(lead, ctx),
        due: sqlUtc(due),
      },
    }
  );
  const taskId = require("../utils/insertId").insertIdOf(ins);
  await writeActivity(leadId, "task_created", { task_id: taskId, reason, rep_id: rep.id, due_at: due.toISOString() });
  if (due <= new Date()) await notifyDue();
  return { action: "task_created", taskId, repId: rep.id, dueAt: due.toISOString() };
}

/** She moved forward: close open tasks for these reasons (all sales reasons if none given). */
async function resolve(leadId, reasons = SALES_REASONS, why = "progressed") {
  const [res] = await sequelize.query(
    `UPDATE rep_tasks SET status = 'cancelled', closed_at = NOW(), close_reason = :why
      WHERE lead_id = :id AND status = 'open' AND reason IN (:reasons)`,
    { replacements: { id: leadId, reasons, why } }
  );
  return res && res.affectedRows ? res.affectedRows : 0;
}

/** Fiza got her number: hand her open stuck reasons to a rep. */
async function onPhoneAdded(leadId) {
  const lead = await one("SELECT id, owner_type, owner_reason FROM leads WHERE id = :id", { id: leadId });
  if (!lead || lead.owner_type !== "fiza") return null;
  const reason = REASONS[lead.owner_reason] ? lead.owner_reason : "onboarding_stalled";
  // She just answered us: the rep should act now, not after the push wait.
  return escalate(leadId, reason, { canPush: false }).catch((e) => {
    console.error("[owner] onPhoneAdded failed:", e.message);
    return null;
  });
}

/** Push reps whose tasks are due (once per task). */
async function notifyDue() {
  const [rows] = await sequelize.query(
    `SELECT t.id, t.rep_id, t.title, t.detail, t.urgency, t.lead_id
       FROM rep_tasks t
      WHERE t.status = 'open' AND t.notified_at IS NULL AND t.due_at <= UTC_TIMESTAMP() AND t.rep_id IS NOT NULL
      ORDER BY t.due_at ASC LIMIT 100`
  );
  const { sendPushToSalesRep } = require("./notificationService");
  for (const t of rows) {
    try {
      await sendPushToSalesRep(t.rep_id, (t.urgency === "hot" ? "🔥 " : "") + t.title, t.detail || "", {
        lead_id: String(t.lead_id),
        task_id: String(t.id),
        kind: "rep_task",
      });
    } catch (e) {
      console.error("[owner] task push failed:", e.message);
    }
    await sequelize.query("UPDATE rep_tasks SET notified_at = NOW() WHERE id = :id", { replacements: { id: t.id } });
  }
  return rows.length;
}

/** Tasks on reps who are no longer active go to an active rep. */
async function moveOffInactiveReps() {
  const [rows] = await sequelize.query(
    `SELECT t.id, t.lead_id FROM rep_tasks t
       LEFT JOIN sales_reps r ON r.id = t.rep_id AND r.status = 'active'
      WHERE t.status = 'open' AND r.id IS NULL LIMIT 100`
  );
  let moved = 0;
  for (const t of rows) {
    const lead = await one("SELECT * FROM leads WHERE id = :id", { id: t.lead_id });
    if (!lead) continue;
    const rep = await ensureRep({ ...lead, assigned_to: null }); // force a new active rep
    if (!rep) break; // nobody active: try again next tick
    await sequelize.query("UPDATE rep_tasks SET rep_id = :rep, notified_at = NULL WHERE id = :id", { replacements: { rep: rep.id, id: t.id } });
    moved++;
  }
  return moved;
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const moved = await moveOffInactiveReps();
    const pushed = await notifyDue();
    if (moved || pushed) console.log(`[owner] tasks moved ${moved}, pushed ${pushed}`);
  } catch (e) {
    console.error("[owner] tick failed:", e.message);
  } finally {
    ticking = false;
  }
}

function startOwnerJob() {
  require("node-cron").schedule("*/5 * * * *", tick);
  console.log("👤 [Owner] Task job scheduled (every 5 min)");
}

module.exports = { escalate, resolve, onPhoneAdded, notifyDue, tick, startOwnerJob, REASONS, SALES_REASONS, dueAt };
