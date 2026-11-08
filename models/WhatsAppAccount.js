const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

const WhatsAppAccount = sequelize.define(
  "WhatsAppAccount",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },

    phone_number: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true
    },

    session_path: {
      type: DataTypes.STRING,
      allowNull: false
    },

    status: {
      type: DataTypes.ENUM("active", "inactive"),
      defaultValue: "active"
    }
  },
  {
    tableName: "whatsapp_accounts",
    timestamps: true
  }
);

module.exports = WhatsAppAccount;
