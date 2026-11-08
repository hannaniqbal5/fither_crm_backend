const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

/**
 * AutomationRule — admin-created rules that the engine evaluates.
 *
 * Channel-agnostic: the `channel` field on both the rule AND the action
 * inside `actions` JSON determines which sender adapter is used.
 * Adding Instagram/email later = zero changes here, just new channel adapters.
 */
const AutomationRule = sequelize.define(
  "AutomationRule",
  {
    rule_id: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },

    name: {
      type: DataTypes.STRING(120),
      allowNull: false,
      comment: "Human label e.g. 24h lead follow-up (Urdu)",
    },

    // Which event fires this rule
    // lead_created | conversation_started | inactivity_24h | inactivity_7d |
    // churn_detected | payment_success | subscription_started | workout_completed
    trigger_event: {
      type: DataTypes.STRING(60),
      allowNull: false,
    },

    // JSON: conditions checked against the person
    // e.g. { "stage": "lead", "language": "ur", "source": "whatsapp" }
    // Use "any" as value to match all: { "stage": "any" }
    conditions: {
      type: DataTypes.JSON,
      allowNull: true,
    },

    // JSON array of actions to execute
    // e.g. [{ "type": "send_message", "template": "followup_ur_1", "channel": "whatsapp" }]
    // type: send_message | update_stage | assign_rep
    // channel: whatsapp | instagram | email | any
    actions: {
      type: DataTypes.JSON,
      allowNull: false,
    },

    // Which channel this rule applies to
    // "any" = fires for all channels (whatsapp, instagram, etc.)
    channel: {
      type: DataTypes.ENUM("whatsapp", "instagram", "email", "any"),
      allowNull: false,
      defaultValue: "any",
    },

    // Minutes to wait before executing actions (0 = immediate)
    delay_minutes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    // Prevents same rule firing twice for same person
    run_once_per_person: {
      type: DataTypes.TINYINT(1),
      allowNull: false,
      defaultValue: 1,
    },

    // Toggle off without deleting
    active: {
      type: DataTypes.TINYINT(1),
      allowNull: false,
      defaultValue: 1,
    },

    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "FK → sales_reps (admin who created this rule)",
    },
  },
  {
    tableName: "automation_rules",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
  }
);

module.exports = AutomationRule;
