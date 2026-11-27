/**
 * executor.js — runs the actions defined in a matched rule.
 *
 * Channel-agnostic: action.channel determines which adapter is used.
 * All message sending goes through channelRouter — never calls Baileys directly.
 *
 * Supported action types:
 *   send_message  — send a template message via channelRouter
 *   update_stage  — update person.stage
 *   assign_rep    — round-robin assign a new rep
 */

const { v4: uuidv4 } = require("uuid");
const { AutomationLog, People } = require("../../models");
const { resolveBilingual, fillPlaceholders } = require("../services/template.service");
const channelRouter = require("../channels/channelRouter");
const { fireEvent }  = require("../services/event.service");

/**
 * executeRule — runs all actions for a matched rule.
 * Writes one AutomationLog row per execution.
 *
 * @param {object} rule   — AutomationRule instance
 * @param {object} person — People instance
 * @param {object} event  — Event instance
 */
async function executeRule(rule, person, event) {
  const logId = uuidv4();
  // Sequelize sometimes returns JSON columns as strings — parse defensively.
  let rawActions = rule.actions;
  if (typeof rawActions === "string") {
    try { rawActions = JSON.parse(rawActions); } catch { rawActions = []; }
  }
  const actions = Array.isArray(rawActions) ? rawActions : [];

  // Create a pending log entry
  await AutomationLog.create({
    log_id:        logId,
    rule_id:       rule.rule_id,
    lead_id:       person.id,
    event_id:      event.event_id,
    channel:       "system",
    status:        "pending",
  });

  try {
    let skippedReason = null;
    for (const action of actions) {
      const outcome = await executeAction(action, rule, person, event, logId);
      if (outcome && outcome.skipped) skippedReason = outcome.reason || "skipped";
    }

    // Mark log as success — or 'skipped' if an action was suppressed (e.g. the
    // send gate denied it, or the channel reported a skip). This keeps gated
    // sends from masquerading as successful sends in the audit log.
    await AutomationLog.update(
      skippedReason
        ? { status: "skipped", error_message: skippedReason }
        : { status: "success" },
      { where: { log_id: logId } }
    );

    console.log(`✅ [Executor] Rule "${rule.name}" ${skippedReason ? "skipped" : "executed"} for person ${person.id}`);

  } catch (err) {
    // Mark log as failed
    await AutomationLog.update(
      { status: "failed", error_message: err.message },
      { where: { log_id: logId } }
    );

    console.error(`❌ [Executor] Rule "${rule.name}" FAILED for person ${person.id}:`, err.message);
  }
}

/**
 * executeAction — handles a single action object.
 */
async function executeAction(action, rule, person, event, logId) {
  switch (action.type) {

    case "send_message": {
      const channel  = action.channel || rule.channel || "any";
      const template = await resolveBilingual(
        action.template,
        person.language || "en",
        channel === "any" ? channelRouter.resolveChannel(person) : channel
      );

      if (!template) {
        throw new Error(`Template "${action.template}" not found`);
      }

      const body = fillPlaceholders(template.body, person, action.extra_vars || {});

      // Master kill-switch + unified send gate (proactive, rule-initiated send).
      try {
        const { canSendProactive, isAutomationPaused } = require("../services/sendGate");
        if (await isAutomationPaused()) {
          console.log(`🚦 [Executor] Rule "${rule.name}" send skipped — automation paused`);
          return { skipped: true, reason: "automation paused" };
        }
        // Admin follow-up switches: stop inactivity follow-ups / leave women
        // inside a campaign to the campaign's own Touch 2 / Touch 3.
        const block = await require("../services/followupSwitches").automationBlock(person.id, event && event.event_type);
        if (block) {
          console.log(`🚦 [Executor] Rule "${rule.name}" send skipped for person ${person.id} — ${block}`);
          return { skipped: true, reason: block };
        }
        const gate = await canSendProactive(person, { accountId: person.whatsapp_account_id, source: "automation" });
        if (!gate.allowed) {
          console.log(`🚦 [Executor] Rule "${rule.name}" send gated for person ${person.id} (${gate.reason})`);
          return { skipped: true, reason: `send gated: ${gate.reason}` };
        }
      } catch (e) {
        console.error("[Executor] gate check failed (allowing):", e.message);
      }

      const result = await channelRouter.send(person, body, channel, template.media_url);

      // Update the log with the actual channel used
      await AutomationLog.update(
        { channel: result.channel || channel },
        { where: { log_id: logId } }
      );

      if (result.skipped) {
        return { skipped: true, reason: result.error || "channel skipped" };
      }

      if (!result.success) {
        throw new Error(result.error || "Channel send failed");
      }

      // Persist the auto-sent message + bump last_message_at (chat history +
      // follow-up silence window) so automation sends are visible & coordinated.
      try {
        const { recordOutbound } = require("../services/outboundMessage");
        await recordOutbound(person, {
          text: body,
          channel: result.channel || "whatsapp",
          externalId: result.messageId,
          mediaUrl: template.media_url || null,
          proactive: true,
          source: "automation",
          templateKey: action.template || null,
          from: "system", // automated — not a person talking to her
        });
      } catch (e) {
        console.error("[Executor] recordOutbound failed:", e.message);
      }

      break;
    }

    case "update_stage": {
      const newStage = action.stage;
      const allowed  = ["visitor", "lead", "user", "churned"];

      if (!allowed.includes(newStage)) {
        throw new Error(`Invalid stage "${newStage}"`);
      }

      await People.update(
        {
          stage: newStage,
          ...(newStage === "churned" && action.churn_trigger
            ? { churn_trigger: action.churn_trigger }
            : {}),
        },
        { where: { id: person.id } }
      );

      // Auto-create pipeline row when person becomes a lead
      if (newStage === "lead") {
        const { Pipeline } = require("../../models");
        await Pipeline.upsert({
          pipeline_id:       uuidv4(),
          lead_id:           person.id,
          stage:             "new",
          assigned_agent_id: person.assigned_to || null,
          stage_entered_at:  new Date(),
        });
        console.log(`📊 [Executor] Pipeline row created for person ${person.id}`);
      }

      // Fire a stage change event for further automation
      await fireEvent(person.id, `stage_changed_${newStage}`, {
        previous_stage: person.stage,
        new_stage:      newStage,
      });

      console.log(`🔄 [Executor] Stage updated: person ${person.id} → ${newStage}`);
      await AutomationLog.update({ channel: "system" }, { where: { log_id: logId } });
      break;
    }

    case "assign_rep": {
      const { getNextRepRoundRobin } = require("../services/assignment.service");
      const nextRep = await getNextRepRoundRobin();

      if (nextRep) {
        await People.update(
          { assigned_to: nextRep.id },
          { where: { id: person.id } }
        );
        console.log(`👤 [Executor] Person ${person.id} reassigned to rep ${nextRep.id}`);
      }

      await AutomationLog.update({ channel: "system" }, { where: { log_id: logId } });
      break;
    }

    default:
      console.warn(`⚠️  [Executor] Unknown action type: "${action.type}" — skipped`);
  }
}

module.exports = { executeRule };
