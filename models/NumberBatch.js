const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

const NumberBatch = sequelize.define(
  "NumberBatch",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    category: {
      type: DataTypes.ENUM("paid", "unpaid"),
      defaultValue: "unpaid",
    },
    original_file: {
      type: DataTypes.STRING(300),
      allowNull: true,
    },
    total_numbers: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    paid_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    unpaid_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    tableName: "number_batches",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  }
);

module.exports = NumberBatch;
