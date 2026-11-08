const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

/**
 * Pipeline — one row per person, tracks their sales funnel position.
 *
 * Unlike Activities (append-only), this row is UPDATED in place when
 * the person moves stages. stage_entered_at resets on every stage change
 * to enable "time-in-stage" queries.
 *
 * assigned_agent_id is separate from People.assigned_to:
 *   - People.assigned_to = who owns the lead overall
 *   - Pipeline.assigned_agent_id = who moves them through the funnel right now
 */
const Pipeline = sequelize.define(
  "Pipeline",
  {
    pipeline_id: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    lead_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      unique: true,
    },
    stage: {
      type: DataTypes.ENUM(
        "new",
        "contacted",
        "consulted",
        "trialing",
        "converted",
        "churned"
      ),
      allowNull: false,
      defaultValue: "new",
    },
    assigned_agent_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    stage_entered_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "pipeline",
    timestamps: true,
    createdAt: false,
    updatedAt: "updated_at",
  }
);

module.exports = Pipeline;
