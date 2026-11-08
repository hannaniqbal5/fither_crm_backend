const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

/**
 * MessageTemplate — bilingual message templates used by the automation engine.
 *
 * Channel-agnostic: each template belongs to a specific channel.
 * Bilingual pairs share a base name with _en / _ur suffix.
 * e.g. "followup_1_en" and "followup_1_ur"
 *
 * Placeholders in body: {{name}}, {{class_name}}, {{phone}}
 */
const MessageTemplate = sequelize.define(
  "MessageTemplate",
  {
    template_id: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },

    // Unique key referenced in automation_rules.actions JSON
    // e.g. "followup_1_ur", "welcome_en", "winback_ur"
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
    },

    // Which channel this template is for
    // whatsapp | instagram | email
    channel: {
      type: DataTypes.ENUM("whatsapp", "instagram", "email"),
      allowNull: false,
      defaultValue: "whatsapp",
    },

    // en | ur
    language: {
      type: DataTypes.ENUM("en", "ur"),
      allowNull: false,
      defaultValue: "en",
    },

    // Message text with {{name}}, {{class_name}} placeholders
    body: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    // Optional image/video URL to attach (WhatsApp media message)
    media_url: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },

    // On/off switch — disable a template without deleting it.
    // The resolver only returns active templates (see template.service.js).
    active: {
      type: DataTypes.TINYINT(1),
      allowNull: false,
      defaultValue: 1,
    },

    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    tableName: "message_templates",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
  }
);

module.exports = MessageTemplate;
