/**
 * scorePromotion.js — Layer 3 of the FitHer Layer System.
 *
 * Runs after Layer 1 (and possibly Layer 2) have updated lead_score.
 * Checks score-threshold crossings and fires:
 *   ≥30  → stage promote visitor → lead (if still visitor)
 *   ≥60  → "warming up" badge (socket event only)
 *   ≥100 → "hot — close priority" + push notification to assigned rep
 *   ≥150 → "urgent — close priority" + stronger push to rep
 *          (surfaced in admin analytics, NOT WhatsApp'd to founder)
 *
 * Idempotent: stores last-fired threshold in intent_history so we don't
 * spam pushes for the same lead repeatedly within the cooldown window.
 *
 * NEVER throws — wrapped by caller.
 */

const sequelize = require("../config/database");
const { loadHistory } = require("./intentHistory");
const { sendPushToSalesRep } = require("../services/notificationService");

const THRESHOLDS = [
  { score: 30,  level: "warming",  action: "promote_stage" },
  { score: 60,  level: "warming",  action: "badge_only" },
  { score: 100, level: "hot",      action: "push_to_rep" },
  { score: 150, level: "urgent",   action: "urgent_push" },
];

const URGENT_PUSH_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Returns the highest threshold a lead crossed BETWEEN previousScore and newScore.
 */
function pickThresholdCrossed(prev, next) {
  if (next <= prev) return null;
  let highest = null;
  for (const t of THRESHOLDS) {
    if (prev < t.score && next >= t.score) highest = t;
  }
  return highest;
}

async function getUrgentThreshold() {
  try {
    const [rows] = await sequelize.query(
      `SELECT setting_value FROM layer_system_settings WHERE setting_key='founder_alert_threshold'`
    );
    return rows[0] ? parseInt(rows[0].setting_value, 10) : 150;
  } catch {
    return 150;
  }
}

function alreadyAlertedRecently(person, level) {
  const history = loadHistory(person);
  const cutoff = Date.now() - URGENT_PUSH_COOLDOWN_MS;
  return history.some(h =>
    h.source === "layer3_promotion" &&
    h.level === level &&
    new Date(h.ts).getTime() > cutoff
  );
}

async function logPromotion(person, threshold) {
  const history = [...loadHistory(person)];
  history.unshift({
    ts: new Date().toISOString(),
    source: "layer3_promotion",
    level: threshold.level,
    action: threshold.action,
    score: person.lead_score,
  });
  await person.update({ intent_history: history.slice(0, 20) });
}

async function maybePromoteStage(person) {
  if (person.stage === "visitor" && person.lead_score >= 30) {
    await person.update({ stage: "lead" });
    console.log(`🆙 [Layer3] Lead ${person.id} promoted visitor → lead`);
    return true;
  }
  return false;
}

/**
 * checkAndPromote — public API
 *
 * @param {object} person     — fresh Sequelize People row
 * @param {number} previousScore — score BEFORE Layer 1 applied delta
 * @param {object} io         — socket.io
 */
async function checkAndPromote(person, previousScore, io) {
  try {
    const newScore = Number(person.lead_score || 0);
    const crossed  = pickThresholdCrossed(previousScore, newScore);
    if (!crossed) return { fired: false };

    // Stage promotion at ≥30 (always)
    if (newScore >= 30 && person.stage === "visitor") {
      await maybePromoteStage(person);
    }

    // Emit socket badge update — both rep room AND admin room
    // (admin room drives the "Hot leads" widget in the Layer System tab)
    if (io && person.assigned_to) {
      io.to(`rep_${person.assigned_to}`).emit("leadPromoted", {
        lead_id: person.id, level: crossed.level, score: newScore,
      });
    }
    if (io) {
      io.to("admins").emit("leadPromoted", {
        lead_id: person.id,
        level: crossed.level,
        score: newScore,
        name: person.name || null,
        phone: person.phone || null,
        interaction_status: person.interaction_status || null,
        main_goal: person.main_goal || null,
        last_objection: person.last_objection || null,
        assigned_to: person.assigned_to || null,
      });
    }

    // Action: push to assigned rep at ≥100
    if (crossed.action === "push_to_rep" && person.assigned_to) {
      sendPushToSalesRep(
        person.assigned_to,
        "🔥 Hot lead — close priority",
        `${person.name || "Lead #" + person.id} reached score ${newScore}`,
        { lead_id: String(person.id), level: "hot" }
      ).catch(e => console.error("[Layer3] push failed:", e.message));
    }

    // Action: urgent push at ≥150 — STRONGER push to assigned rep
    // (No WhatsApp to founder anymore — admin sees this in the
    //  "Hot/Urgent leads" analytics widget instead.)
    if (crossed.action === "urgent_push") {
      const dynamicThreshold = await getUrgentThreshold();
      if (newScore >= dynamicThreshold && !alreadyAlertedRecently(person, "urgent")) {
        if (person.assigned_to) {
          sendPushToSalesRep(
            person.assigned_to,
            "🚨 URGENT — close now",
            `${person.name || "Lead #" + person.id} hit score ${newScore} — top priority`,
            { lead_id: String(person.id), level: "urgent" }
          ).catch(() => {});
        }
        console.log(`🚨 [Layer3] Lead ${person.id} flagged URGENT at score ${newScore}`);
      }
    }

    await logPromotion(person, crossed);
    console.log(`📈 [Layer3] Lead ${person.id} crossed ${crossed.score} (${crossed.level})`);
    return { fired: true, level: crossed.level, score: newScore };

  } catch (err) {
    console.error("❌ [Layer3] suppressed error:", err.message);
    return { fired: false, error: err.message };
  }
}

module.exports = { checkAndPromote, THRESHOLDS };
