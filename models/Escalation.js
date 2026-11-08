const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");
const People = require("./People");    // was Lead
const SalesRep = require("./SalesRep");

const Escalation = sequelize.define(
  "Escalation",
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    lead_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    raised_by: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    assigned_to: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    issue_type: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM("open", "in_progress", "resolved"),
      defaultValue: "open",
    },
    resolved_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "escalations",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
  }
);

People.hasMany(Escalation, { foreignKey: "lead_id" });
Escalation.belongsTo(People, { foreignKey: "lead_id" });

SalesRep.hasMany(Escalation, { foreignKey: "assigned_to" });
Escalation.belongsTo(SalesRep, { foreignKey: "assigned_to" });

module.exports = Escalation;
