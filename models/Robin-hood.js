const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

const AssignmentState = sequelize.define(
  "AssignmentState",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },

    whatsapp_account_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Round-robin pointer is kept per WhatsApp account (null = legacy/global)",
    },

    last_rep_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Last sales rep assigned (round-robin pointer)",
    },
  },
  {
    tableName: "assignment_state",
    timestamps: true,
    createdAt: false,       // not needed
    updatedAt: "updated_at"
  }
);

module.exports = AssignmentState;
