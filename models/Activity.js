const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

/**
 * Activity — append-only log of every touchpoint per person.
 * Never updated, only inserted. Composite index on (lead_id, created_at).
 */
const Activity = sequelize.define(
  "Activity",
  {
    activity_id: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    lead_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    // message_received | workout_started | workout_completed |
    // payment_completed | subscription_started | form_submitted |
    // session_joined | consultation_booked
    activity_type: {
      type: DataTypes.STRING(60),
      allowNull: false,
    },
    // whatsapp | instagram | app | stripe | system
    source: {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: "whatsapp",
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    tableName: "activities",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
  }
);

module.exports = Activity;
