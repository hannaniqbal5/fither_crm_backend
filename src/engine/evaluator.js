/**
 * evaluator.js — checks if a rule's conditions match a person + event.
 *
 * Conditions are a JSON object on the rule:
 * { "stage": "lead", "language": "ur", "source": "whatsapp" }
 *
 * Use "any" as a value to match all:
 * { "stage": "any", "language": "ur" }
 */

const { AutomationLog } = require("../../models");

/**
 * evaluateConditions — returns true if all conditions match.
 *
 * @param {object} rule    — AutomationRule instance
 * @param {object} person  — People instance
 * @param {object} event   — Event instance
 */
async function evaluateConditions(rule, person, event) {
  // MySQL/Sequelize sometimes returns JSON columns as strings rather than parsed objects.
  // Handle both cases defensively.
  let conditions = rule.conditions || {};
  if (typeof conditions === "string") {
    try { conditions = JSON.parse(conditions); }
    catch (e) {
      console.warn(`⚠️  [Evaluator] Rule "${rule.name}" has unparseable conditions JSON`);
      conditions = {};
    }
  }

  // Check each condition field against person
  for (const [field, expected] of Object.entries(conditions)) {
    if (expected === "any") continue;  // wildcard — always passes

    const actual = person[field];

    // Support array of allowed values: { "stage": ["lead", "user"] }
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) {
        console.log(
          `⏭  [Evaluator] Rule "${rule.name}" — condition FAILED: ` +
          `${field}="${actual}" not in [${expected.join(", ")}]`
        );
        return false;
      }
    } else {
      if (String(actual) !== String(expected)) {
        console.log(
          `⏭  [Evaluator] Rule "${rule.name}" — condition FAILED: ` +
          `${field}="${actual}" !== "${expected}"`
        );
        return false;
      }
    }
  }

  // run_once_per_person check — skip if already fired for this person
  if (rule.run_once_per_person) {
    const alreadyRan = await AutomationLog.findOne({
      where: {
        rule_id: rule.rule_id,
        lead_id: person.id,
        status:  "success",
      },
    });

    if (alreadyRan) {
      console.log(
        `⏭  [Evaluator] Rule "${rule.name}" already ran for person ${person.id} — skipping`
      );
      return false;
    }
  }

  return true;
}

module.exports = { evaluateConditions };
