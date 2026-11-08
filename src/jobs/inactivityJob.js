/**
 * inactivityJob.js — runs every hour via node-cron.
 *
 * Detects people who have gone quiet and fires inactivity events.
 * These events are picked up by the engine on the next 30s poll cycle,
 * which then sends automated follow-up messages via the correct channel.
 *
 * Two thresholds:
 *   24h — fires inactivity_24h for leads  (stage = lead)
 *   7d  — fires inactivity_7d for users   (stage = user)
 */

const cron = require("node-cron");
const { Op } = require("sequelize");
const { People } = require("../../models");
const { fireEvent } = require("../services/event.service");

// Thresholds — change these for local testing
// e.g. set INACTIVITY_24H_MINUTES=2 in .env to test with 2 minutes
const THRESHOLD_24H_MS = (parseInt(process.env.INACTIVITY_24H_MINUTES) || 24 * 60) * 60 * 1000;
const THRESHOLD_7D_MS  = (parseInt(process.env.INACTIVITY_7D_DAYS)    || 7)  * 24 * 60 * 60 * 1000;

async function runInactivityCheck() {
  console.log("⏰ [InactivityJob] Running inactivity check...");

  const now = new Date();

  try {
    // ── 24h check — leads only ────────────────────────────────
    const threshold24h = new Date(now.getTime() - THRESHOLD_24H_MS);

    const inactiveLeads = await People.findAll({
      where: {
        stage: "lead",
        last_activity_at: { [Op.lt]: threshold24h },
      },
    });

    console.log(`[InactivityJob] Found ${inactiveLeads.length} inactive lead(s) (24h)`);

    for (const person of inactiveLeads) {
      await fireEvent(person.id, "inactivity_24h", {
        last_activity_at: person.last_activity_at,
        stage: person.stage,
        source: person.source,
        channel: person.source,
      });
    }

    // ── 7d check — users only ─────────────────────────────────
    const threshold7d = new Date(now.getTime() - THRESHOLD_7D_MS);

    const inactiveUsers = await People.findAll({
      where: {
        stage: "user",
        last_activity_at: { [Op.lt]: threshold7d },
      },
    });

    console.log(`[InactivityJob] Found ${inactiveUsers.length} inactive user(s) (7d)`);

    for (const person of inactiveUsers) {
      await fireEvent(person.id, "inactivity_7d", {
        last_activity_at: person.last_activity_at,
        stage: person.stage,
        source: person.source,
        channel: person.source,
      });
    }

    console.log("✅ [InactivityJob] Done");

  } catch (err) {
    console.error("❌ [InactivityJob] Error:", err.message);
  }
}

/**
 * startInactivityJob — registers the cron schedule and starts it.
 * Called once from App.js.
 */
function startInactivityJob() {
  // Run every hour at minute 0
  cron.schedule("0 * * * *", runInactivityCheck);
  console.log("⏰ [InactivityJob] Scheduled — runs every hour");

  // Run once immediately on startup for fast feedback during dev
  // Remove this line in production if you don't want an immediate run
  runInactivityCheck();
}

module.exports = { startInactivityJob, runInactivityCheck };
