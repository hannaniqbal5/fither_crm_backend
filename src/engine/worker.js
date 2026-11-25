/**
 * worker.js — the automation engine polling loop.
 *
 * Runs every 30 seconds. Picks up unprocessed events from the events table,
 * evaluates matching rules, executes actions, marks events processed.
 *
 * Completely decoupled from HTTP — runs on its own setInterval.
 * Crash-safe: errors are caught per-event, one bad event never stops the loop.
 */

const { Event, People, AutomationRule } = require("../../models");
const { evaluateConditions } = require("./evaluator");
const { executeRule }        = require("./executor");

const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

let isRunning = false; // prevent overlapping runs

async function runWorker() {
  if (isRunning) {
    console.log("⏳ [Worker] Previous cycle still running — skipping this tick");
    return;
  }

  isRunning = true;

  try {
    // Fetch all unprocessed events (oldest first)
    const events = await Event.findAll({
      where: { processed: 0 },
      order:  [["created_at", "ASC"]],
      limit:  50,  // process max 50 per cycle to avoid overload
    });

    if (events.length === 0) {
      isRunning = false;
      return;
    }

    console.log(`🔄 [Worker] Processing ${events.length} event(s)...`);

    for (const event of events) {
      try {
        await processEvent(event);

        // Mark processed regardless of whether any rule matched
        await event.update({ processed: 1 });

      } catch (err) {
        console.error(
          `❌ [Worker] Error processing event ${event.event_id} (${event.event_type}):`,
          err.message
        );
        // Still mark processed to avoid infinite retry on broken events
        await event.update({ processed: 1 });
      }
    }

  } catch (err) {
    console.error("❌ [Worker] Poll cycle failed:", err.message);
  }

  isRunning = false;
}

async function processEvent(event) {
  // Load the person this event belongs to
  const person = await People.findByPk(event.lead_id);
  if (!person) {
    console.warn(`⚠️  [Worker] Person ${event.lead_id} not found for event ${event.event_id}`);
    return;
  }

  // Load all active rules that match this event type
  const rules = await AutomationRule.findAll({
    where: {
      trigger_event: event.event_type,
      active: 1,
    },
  });

  if (rules.length === 0) return;

  console.log(
    `⚡ [Worker] Event "${event.event_type}" for person ${person.id} — ` +
    `checking ${rules.length} rule(s)`
  );

  for (const rule of rules) {
    try {
      const matches = await evaluateConditions(rule, person, event);
      if (!matches) continue;

      if (rule.delay_minutes > 0) {
        // Delayed execution — setTimeout (in-memory, crash-safe enough for Phase 2)
        const delayMs = rule.delay_minutes * 60 * 1000;
        console.log(
          `⏰ [Worker] Rule "${rule.name}" will fire in ${rule.delay_minutes}min ` +
          `for person ${person.id}`
        );
        setTimeout(() => executeRule(rule, person, event).catch(console.error), delayMs);
      } else {
        // Immediate execution
        await executeRule(rule, person, event);
      }

    } catch (err) {
      console.error(
        `❌ [Worker] Rule "${rule.name}" failed for person ${person.id}:`,
        err.message
      );
    }
  }
}

/**
 * startWorker — call once from App.js to begin the polling loop.
 */
function startWorker() {
  console.log(`🚀 [Worker] Automation engine started — polling every ${POLL_INTERVAL_MS / 1000}s`);
  const job = require("../monitor/jobs").wrap("automation-engine", runWorker, { ttlSec: 300 });
  job(); // run immediately on start
  setInterval(job, POLL_INTERVAL_MS);
}

module.exports = { startWorker };
