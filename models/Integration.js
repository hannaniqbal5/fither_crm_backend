const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

/**
 * Integration — tracks connection health for each external service.
 * Baileys health-check cron updates last_ping_at + status every minute.
 */
const Integration = sequelize.define(
  "Integration",
  {
    integration_id: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    // baileys_wa | stripe | flutter_app | instagram
    name: {
      type: DataTypes.STRING(80),
      allowNull: false,
    },
    // whatsapp | instagram | payment | app
    type: {
      type: DataTypes.ENUM("whatsapp", "instagram", "payment", "app"),
      allowNull: false,
    },
    config: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    // active | disconnected | error
    status: {
      type: DataTypes.ENUM("active", "disconnected", "error"),
      allowNull: false,
      defaultValue: "disconnected",
    },
    last_ping_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "integrations",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
  }
);

module.exports = Integration;
