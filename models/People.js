const { DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

const WhatsAppAccount = require("./WhatsAppAccount");
const SalesRep = require("./SalesRep");

/**
 * People — central identity table.
 * Every person (visitor, lead, user, churned) has exactly one row.
 * phone + whatsapp_account_id is the dedup key from WhatsApp.
 *
 * Renamed from Lead → People (blueprint alignment).
 * DB table stays `leads` so existing data is preserved without migration.
 */
const People = sequelize.define(
  "People",
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING(180),
      allowNull: true,
    },
    // visitor | lead | user | churned
    stage: {
      type: DataTypes.ENUM("visitor", "lead", "user", "churned"),
      defaultValue: "visitor",
    },
    // en | ur — automation engine uses for bilingual templates
    language: {
      type: DataTypes.ENUM("en", "ur"),
      defaultValue: "en",
    },
    // Recalculated on every activity write
    lead_score: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    // Firebase UID — set when Flutter app user links
    app_user_id: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    // none | trial | active | frozen | expired | cancelled
    subscription_status: {
      type: DataTypes.ENUM("none", "trial", "active", "frozen", "expired", "cancelled"),
      defaultValue: "none",
    },
    // subscription_cancelled | payment_failed_3x
    churn_trigger: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    // Existing rep-facing status (kept alongside stage)
    status: {
      type: DataTypes.ENUM("new", "interested", "followup", "converted", "lost"),
      defaultValue: "new",
    },
    unread_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    whatsapp_jid: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    assigned_to: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    is_escalated: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    escalated_to: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    escalated_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    last_message_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // Indexed — inactivity worker queries this column
    last_activity_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // whatsapp | instagram | facebook | website | app | ad | organic | referral | unknown
    source: {
      type: DataTypes.ENUM("whatsapp","instagram","facebook","website","app","ad","organic","referral","unknown"),
      allowNull: false,
      defaultValue: "whatsapp",
    },
    campaign_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    whatsapp_account_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // ── Meta channels (Instagram + Facebook) ─────────────────
    instagram_psid: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    instagram_username: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    facebook_psid: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    facebook_name: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    meta_page_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // ── Layer System v1 (intent + funnel + goals) ────────────────
    interaction_status: {
      type: DataTypes.ENUM(
        "new_inbound","awaiting_reply","active_chat","ghosted",
        "asking_about_program","asking_about_price","comparing_plans","discussing_with_family","requesting_trial",
        "price_negotiation","price_objection","timing_objection","medical_concern","husband_blocking","will_start_later",
        "callback_scheduled","ready_to_pay","payment_link_sent","payment_pending","onboarded",
        "not_interested","wrong_number","lost_to_competitor","opted_out"
      ),
      allowNull: true,
    },
    main_goal: {
      type: DataTypes.ENUM("pcos","weight_loss","weight_gain","postpartum","diabetes","general"),
      allowNull: true,
    },
    last_objection: {
      type: DataTypes.ENUM("price","timing","family","medical","fit","none"),
      defaultValue: "none",
    },
    funnel_stage: {
      type: DataTypes.TINYINT,
      defaultValue: 1,
    },
    last_intent_detected_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    auto_followup_paused: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    intent_history: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    goal_detected_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // ── Phase 6 — App integration columns (added to model; were DB-only) ──
    subscription_plan_id: { type: DataTypes.INTEGER, allowNull: true },
    subscription_plan_title: { type: DataTypes.STRING(160), allowNull: true },
    subscription_started_at: { type: DataTypes.DATE, allowNull: true },
    subscription_expires_at: { type: DataTypes.DATE, allowNull: true },
    subscription_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    subscription_currency: { type: DataTypes.STRING(3), allowNull: true },
    last_login_at: { type: DataTypes.DATE, allowNull: true },
    total_workouts_completed: { type: DataTypes.INTEGER, defaultValue: 0 },
    total_diet_days_completed: { type: DataTypes.INTEGER, defaultValue: 0 },
    lifetime_value_pkr: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    has_pcos: { type: DataTypes.TINYINT, defaultValue: 0 },
    target_weight_kg: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
    main_goal_app: { type: DataTypes.STRING(80), allowNull: true },
    app_timezone: { type: DataTypes.STRING(60), allowNull: true },
    app_synced_at: { type: DataTypes.DATE, allowNull: true },
    // ── Phase 6b — Onboarding tracking ──
    app_signed_up_at: { type: DataTypes.DATE, allowNull: true },
    app_onboarding_step: { type: DataTypes.TINYINT, allowNull: true },
    app_onboarded_at: { type: DataTypes.DATE, allowNull: true },
    app_onboarding_stalled_at: { type: DataTypes.DATE, allowNull: true },
    // ── Merge tracking ──
    merged_into_lead_id: { type: DataTypes.BIGINT, allowNull: true },
    // ── Phase 15c — First-touch flow ──────────────────────────────
    engagement_step: {
      type: DataTypes.TINYINT.UNSIGNED,
      defaultValue: 0,
      // 0 = no Fiza reply yet, 1 = first text sent, 2 = voice sent, 3 = poster sent, 4+ = normal flow
    },
  },
  {
    tableName: "leads",     // DB table stays `leads` — no data loss
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,  // TODO: enable after running: ALTER TABLE leads ADD COLUMN updated_at DATETIME NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP;
    indexes: [
      { unique: true, fields: ["phone", "whatsapp_account_id"] },
      { fields: ["stage", "last_activity_at"], name: "idx_stage_activity" },
      { fields: ["interaction_status"], name: "idx_interaction_status" },
      { fields: ["main_goal"], name: "idx_main_goal" },
      { fields: ["funnel_stage"], name: "idx_funnel_stage" },
    ],
  }
);

WhatsAppAccount.hasMany(People, { foreignKey: "whatsapp_account_id" });
People.belongsTo(WhatsAppAccount, { foreignKey: "whatsapp_account_id" });

SalesRep.hasMany(People, { foreignKey: "assigned_to" });
People.belongsTo(SalesRep, { foreignKey: "assigned_to" });

module.exports = People;
