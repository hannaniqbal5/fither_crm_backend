const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

/**
 * Event — automation engine queue.
 * Automation engine polls WHERE processed = 0 every 30s (Phase 2).
 * Phase 1: we just write the rows so they're ready.
 */
const Event = sequelize.define(
  "Event",
  {
    event_id: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    lead_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    // lead_created | conversation_started | signup_completed |
    // subscription_started | payment_success | payment_failed |
    // workout_started | workout_completed | inactivity_24h |
    // inactivity_7d | churn_detected | subscription_cancelled
    event_type: {
      type: DataTypes.STRING(60),
      allowNull: false,
    },
    // Context for rule evaluation e.g. {"plan":"monthly","amount":1500}
    payload: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    // 0 = unprocessed, 1 = done
    processed: {
      type: DataTypes.TINYINT(1),
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    tableName: "events",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
  }
);

module.exports = Event;
