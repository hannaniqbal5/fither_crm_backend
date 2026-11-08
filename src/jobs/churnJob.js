/**
 * churnJob.js — runs daily at 02:00 via node-cron.
 *
 * Detects people with 3+ payment_failed events in the last 30 days.
 * Flips their stage to "churned", sets churn_trigger, fires churn_detected event.
 * The engine then picks up the event and sends the win-back message.
 */

const cron = require("node-cron");
const { Op, Sequelize } = require("sequelize");
const { People, Event, sequelize } = require("../../models");
const { fireEvent } = require("../services/event.service");

async function runChurnCheck() {
  console.log("💔 [ChurnJob] Running churn detection...");

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Find people with 3+ payment_failed events in last 30 days
    // who are not already churned
    const results = await Event.findAll({
      attributes: [
        "lead_id",
        [Sequelize.fn("COUNT", Sequelize.col("event_id")), "fail_count"],
      ],
      where: {
        event_type: "payment_failed",
        created_at: { [Op.gte]: thirtyDaysAgo },
      },
      group: ["lead_id"],
      having: Sequelize.literal("COUNT(event_id) >= 3"),
      raw: true,
    });

    console.log(`[ChurnJob] Found ${results.length} person(s) with 3+ payment failures`);

    for (const row of results) {
      const person = await People.findByPk(row.lead_id);
      if (!person || person.stage === "churned") continue;

      // Flip to churned
      await person.update({
        stage:         "churned",
        churn_trigger: "payment_failed_3x",
      });

      // Fire churn event — engine will handle win-back message
      await fireEvent(person.id, "churn_detected", {
        trigger:    "payment_failed_3x",
        fail_count: parseInt(row.fail_count),
        source:     person.source,
        channel:    person.source,
      });

      console.log(`💔 [ChurnJob] Person ${person.id} (${person.phone}) marked as churned`);
    }

    console.log("✅ [ChurnJob] Done");

  } catch (err) {
    console.error("❌ [ChurnJob] Error:", err.message);
  }
}

/**
 * startChurnJob — registers the daily 02:00 cron and starts it.
 * Called once from App.js.
 */
function startChurnJob() {
  // Every day at 02:00
  cron.schedule("0 2 * * *", runChurnCheck);
  console.log("💔 [ChurnJob] Scheduled — runs daily at 02:00");
}

module.exports = { startChurnJob, runChurnCheck };
