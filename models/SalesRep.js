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
    },

    // Per-rep Fiza autonomy, set by the admin. NULL = inherit the channel
    // default. 'copilot' = Fiza drafts for this rep to approve; 'autopilot' =
    // Fiza replies on its own for this rep's leads (routine traffic only —
    // guardrails in replyOwner still pull a human in). See migration 040.
    fiza_mode: {
      type: DataTypes.ENUM("copilot", "autopilot"),
      allowNull: true,
      defaultValue: null
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
