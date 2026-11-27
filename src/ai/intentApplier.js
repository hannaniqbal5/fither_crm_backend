/**
 * intentApplier.js — wires Layer 1 detection into the People row.
 *
 * Called by message.handler.js on every inbound text message.
 * Updates: interaction_status, main_goal, last_objection, funnel_stage,
 *          lead_score, last_intent_detected_at, intent_history.
 *
 * Emits socket events so the dashboard re-renders pills immediately.
 *
 * NEVER throws — wrapped in try/catch by caller, but we also no-op on errors
 * so a bad regex never blocks the chat pipeline.
 */

const { detect, funnelStageFor, SCORE_DELTAS } = require("./intentDetector");
const { loadHistory } = require("./intentHistory");
const { legacyStatusFor } = require("./statusMap");
const { fireEvent } = require("../services/event.service");

const SCORE_LOCK_VALUE = -100;

// ── Intent → lifecycle stage bridge ──
// Engaged/warm/hot intents make a contact a real "lead" even if lead_score
// hasn't crossed the Layer-3 threshold yet. We NEVER auto-promote to "user"
// (that's reserved for confirmed payment via the app/payment integration) and
// NEVER downgrade.
const LEAD_GRADE_INTENTS = new Set([
  "active_chat",
  "asking_about_program", "asking_about_price", "comparing_plans",
  "discussing_with_family", "requesting_trial",
  "price_negotiation", "price_objection", "timing_objection",
  "medical_concern", "husband_blocking", "will_start_later",
  "callback_scheduled", "ready_to_pay", "payment_link_sent",
  "payment_pending", "onboarded",
]);
const STAGE_RANK = { visitor: 0, lead: 1, user: 2 };

// Statuses the generic "active_chat" fallback (no keyword matched) may replace.
// Anything else (ready_to_pay, asking_about_price, objections, …) is a real
// signal and must survive a plain "ok" / "thanks" message.
const FALLBACK_REPLACEABLE = new Set([null, undefined, "", "new_inbound", "awaiting_reply", "ghosted", "active_chat"]);

/**
 * applyIntent — main entry point.
 *
 * @param {object} person  — Sequelize People row (must be reloadable)
 * @param {string} text    — inbound message body
 * @param {object} io      — socket.io server (optional)
 * @returns {Promise<{ changed, detected }>}
 */
async function applyIntent(person, text, io) {
  try {
    const detected = detect(text, person);
    if (!detected.interaction_status && !detected.main_goal && !detected.last_objection) {
      return { changed: false, detected };
    }

    // Guard: opted_out is permanent — don't let intent detection accidentally re-engage
    if (person.interaction_status === "opted_out") {
      return { changed: false, detected, reason: "opted_out_locked" };
    }

    // Capture stage before any update so we can detect a NET stage change at the
    // end (score-driven or intent-driven) and fire one stage_changed event.
    const stageBefore = person.stage;

    const patch = {
      last_intent_detected_at: new Date(),
    };

    // ── interaction_status — explicit keyword matches always win (latest
    //    signal); the no-match default only replaces a low/idle status. ──
    const keepExisting =
      detected.status_fallback && !FALLBACK_REPLACEABLE.has(person.interaction_status);
    if (detected.interaction_status && !keepExisting) {
      patch.interaction_status = detected.interaction_status;
      // ── legacy `status` auto-sync ──
      // Bridges the new 24-value taxonomy to the 5-value sidebar filter
      // (New / Interested / Followup / Converted / Lost). Never downgrade
      // a "converted" lead — that's a paid state, manual or stage-flip only.
      const newLegacy = legacyStatusFor(detected.interaction_status);
      if (newLegacy && person.status !== "converted" && newLegacy !== person.status) {
        patch.status = newLegacy;
      }
    }

    // ── main_goal — only set if missing (sticky, manual override clears it) ──
    // (An app goal is copied into main_goal on arrival, so this never
    //  overrides it; the extra check covers a lead synced before that.)
    if (detected.main_goal && !person.main_goal && !require("../services/goalMap").appGoalOf(person)) {
      patch.main_goal = detected.main_goal;
      patch.goal_detected_at = new Date();
    }

    // ── last_objection — update only if new objection detected (don't clobber active one) ──
    if (detected.last_objection) {
      patch.last_objection = detected.last_objection;
    }

    // ── lead_score — apply delta / reset / lock ──
    const currentScore = Number(person.lead_score || 0);
    if (detected.score_op === "reset") {
      patch.lead_score = 0;
    } else if (detected.score_op === "lock") {
      patch.lead_score = SCORE_LOCK_VALUE;
    } else if (detected.score_delta) {
      // Cap at [-100, +9999]
      patch.lead_score = Math.max(SCORE_LOCK_VALUE, Math.min(9999, currentScore + detected.score_delta));
    }

    // ── funnel_stage — recompute based on full merged state ──
    const merged = { ...person.toJSON?.() || person, ...patch };
    patch.funnel_stage = funnelStageFor(merged);

    // ── intent_history — keep last 10 ──
    const history = [...loadHistory(person)];
    history.unshift({
      ts: new Date().toISOString(),
      source: "layer1_detector",
      matched_rules: detected.matched_rules,
      previous: {
        interaction_status: person.interaction_status,
        main_goal: person.main_goal,
        last_objection: person.last_objection,
        funnel_stage: person.funnel_stage,
        lead_score: currentScore,
      },
      detected: {
        interaction_status: detected.interaction_status,
        main_goal: detected.main_goal,
        last_objection: detected.last_objection,
        score_delta: detected.score_delta,
        score_op: detected.score_op,
      },
      next: {
        interaction_status: patch.interaction_status ?? person.interaction_status,
        main_goal: patch.main_goal ?? person.main_goal,
        last_objection: patch.last_objection ?? person.last_objection,
        funnel_stage: patch.funnel_stage,
        lead_score: patch.lead_score ?? currentScore,
      },
    });
    patch.intent_history = history.slice(0, 10);

    await person.update(patch);

    // ── Layer 3 — score-driven promotion (stage promote + rep push) ──
    try {
      const { checkAndPromote } = require("./scorePromotion");
      await checkAndPromote(person, currentScore, io);
    } catch (e) {
      console.error("⚠️  [Layer3] suppressed:", e.message);
    }

    // ── Intent → stage bridge ──
    // Promote visitor → lead on real buying/engagement intent (complements the
    // score-based promotion above). No downgrade; never auto-flip to "user".
    try {
      const ns = patch.interaction_status;
      if (
        ns && LEAD_GRADE_INTENTS.has(ns) &&
        person.stage !== "user" && person.stage !== "churned" &&
        STAGE_RANK["lead"] > (STAGE_RANK[person.stage] ?? 0)
      ) {
        await person.update({ stage: "lead" });
        console.log(`🆙 [IntentBridge] Lead ${person.id} promoted ${stageBefore} → lead (intent: ${ns})`);
      }
    } catch (e) {
      console.error("⚠️  [IntentBridge] suppressed:", e.message);
    }

    // ── Connect to the automation engine ──
    // If stage actually changed during this pass, fire ONE stage_changed event
    // so automation rules can react. Inert unless an admin has a matching rule.
    if (person.stage !== stageBefore) {
      try {
        await fireEvent(person.id, `stage_changed_${person.stage}`, {
          previous_stage: stageBefore,
          new_stage: person.stage,
          source: "layer_intent",
        });
      } catch (e) {
        console.error("⚠️  [IntentBridge] stage event failed:", e.message);
      }
    }

    // Emit socket event so dashboard live-updates
    if (io) {
      const repRoom = person.assigned_to ? `rep_${person.assigned_to}` : null;
      const payload = {
        lead_id: person.id,
        interaction_status: patch.interaction_status ?? person.interaction_status,
        main_goal: patch.main_goal ?? person.main_goal,
        last_objection: patch.last_objection ?? person.last_objection,
        funnel_stage: patch.funnel_stage,
        lead_score: patch.lead_score ?? currentScore,
      };
      if (repRoom) io.to(repRoom).emit("intentUpdated", payload);
      io.to("admins").emit("intentUpdated", payload);
    }

    console.log(
      `🎯 [Intent] Lead ${person.id} → ${patch.interaction_status || "—"} ` +
      `(goal: ${patch.main_goal || person.main_goal || "—"}, ` +
      `obj: ${patch.last_objection || person.last_objection || "—"}, ` +
      `score: ${currentScore} → ${patch.lead_score ?? currentScore})`
    );

    return { changed: true, detected, patch };

  } catch (err) {
    console.error("❌ [intentApplier] suppressed error:", err.message);
    return { changed: false, error: err.message };
  }
}

module.exports = { applyIntent };
