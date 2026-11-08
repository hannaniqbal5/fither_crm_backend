const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

const PaymentAccount = sequelize.define(
  "PaymentAccount",
  {
    id:             { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    country_code:   { type: DataTypes.STRING(2),  allowNull: false }, // ISO 3166 alpha-2
    country_name:   { type: DataTypes.STRING(80), allowNull: false },
    currency:       { type: DataTypes.STRING(8),  allowNull: false, defaultValue: "PKR" },
    account_type:   {
      type: DataTypes.ENUM("bank", "jazzcash", "easypaisa", "sadapay", "nayapay", "paypal", "wise", "other"),
      allowNull: false,
      defaultValue: "bank",
    },
    bank_name:      { type: DataTypes.STRING(120), allowNull: false },
    account_holder: { type: DataTypes.STRING(160), allowNull: false },
    account_number: { type: DataTypes.STRING(60),  allowNull: false },
    iban:           { type: DataTypes.STRING(60),  allowNull: true },
    branch_code:    { type: DataTypes.STRING(40),  allowNull: true },
    swift_code:     { type: DataTypes.STRING(20),  allowNull: true },
    instructions:   { type: DataTypes.TEXT,        allowNull: true },
    is_active:      { type: DataTypes.BOOLEAN,     allowNull: false, defaultValue: true },
    display_order:  { type: DataTypes.INTEGER,     allowNull: false, defaultValue: 0 },
    created_by:     { type: DataTypes.INTEGER,     allowNull: true },
  },
  {
    tableName: "payment_accounts",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  }
);

module.exports = PaymentAccount;
