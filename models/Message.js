const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");
const People = require("./People");   // was Lead

const Message = sequelize.define(
  "Message",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    lead_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    rep_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    from: {
      type: DataTypes.ENUM("user", "rep", "bot"),
      allowNull: false,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    direction: {
      type: DataTypes.ENUM("IN", "OUT"),
      allowNull: false,
    },
    message_type: {
      type: DataTypes.ENUM(
        "text","image","video","audio","voice","document","sticker","location"
      ),
      defaultValue: "text",
    },
    whatsapp_account_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    media_url: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    media_mime: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    media_size: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    duration: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    file_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // Phase 17 — voice transcription
    voice_transcript: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    voice_transcript_lang: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },
    voice_confidence: {
      type: DataTypes.DECIMAL(4, 3),
      allowNull: true,
    },
    voice_transcribed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    whatsapp_message_id: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    status: {
      type: DataTypes.ENUM("sending","sent","delivered","read","received"),
      defaultValue: "received",
    },
    is_read: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    whatsapp_message_id: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    lead_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    rep_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Multichannel — Phase 4 (+ "app" = first-party in-app channel)
    channel: {
      type: DataTypes.ENUM("whatsapp","instagram","facebook","app"),
      defaultValue: "whatsapp",
    },
    external_message_id: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
    // Phase 17 — voice transcription
    voice_transcript: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    voice_transcript_lang: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },
    voice_confidence: {
      type: DataTypes.DECIMAL(4, 3),
      allowNull: true,
    },
    voice_transcribed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "messages",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  }
);

module.exports = Message;
