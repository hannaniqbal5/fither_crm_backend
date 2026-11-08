const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");
const WhatsAppAccount = require("./WhatsAppAccount");

const SalesRep = sequelize.define(
  "SalesRep",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },

    name: {
      type: DataTypes.STRING,
      allowNull: false
    },

    email: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false
    },

    password: {
      type: DataTypes.STRING,
      allowNull: false
    },

    role: {
      type: DataTypes.ENUM("rep", "admin"),
      defaultValue: "rep"
    },

    status: {
      type: DataTypes.ENUM("active", "inactive"),
      defaultValue: "active"
    },

    whatsapp_account_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },

    // FK to partner_backend.users.id — populated when this rep
    // authenticates via partner_backend's /admin/login (userType =
    // Customer_Support_Representative). Null for admin accounts that
    // live only in the CRM.
    partner_user_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  },
  {
    tableName: "sales_reps",
    timestamps: true
  }
);

// Relations
WhatsAppAccount.hasMany(SalesRep, {
  foreignKey: "whatsapp_account_id"
});
SalesRep.belongsTo(WhatsAppAccount, {
  foreignKey: "whatsapp_account_id"
});

module.exports = SalesRep;
