const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

/**
 * AutomationLog — every rule execution writes one row here.
 * Used for debugging, auditing, and run_once_per_person checks.
 * Channel is recorded so logs can be filtered by channel in the frontend.
 */
const AutomationLog = sequelize.define(
  "AutomationLog",
  {
    log_id: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },

    rule_id: {
      type: DataTypes.CHAR(36),
      allowNull: false,
    },

    lead_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },

    event_id: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      comment: "Which event triggered this execution",
    },

    // Which channel was actually used for this execution
    // whatsapp | instagram | email | system (for non-message actions)
    channel: {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: "system",
    },

    // pending | success | failed | skipped
    status: {
      type: DataTypes.ENUM("pending", "success", "failed", "skipped"),
      allowNull: false,
      defaultValue: "pending",
    },

    // NULL unless status = failed
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: "automation_logs",
    timestamps: true,
    createdAt: "executed_at",
    updatedAt: false,
  }
);

module.exports = AutomationLog;
