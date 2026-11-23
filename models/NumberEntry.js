const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

const NumberEntry = sequelize.define(
  "NumberEntry",
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    batch_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    phone: {
      type: DataTypes.STRING(30),
      allowNull: false,
    },
    phone_last10: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
    category: {
      type: DataTypes.ENUM("paid", "unpaid"),
      defaultValue: "unpaid",
    },
    extra_data: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    notes: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
  },
  {
    tableName: "number_entries",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  }
);

module.exports = NumberEntry;
