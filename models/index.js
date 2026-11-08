const { Sequelize, DataTypes } = require("sequelize");
const sequelize = require("../src/config/database");

// ── Core models (Phase 1) ─────────────────────────────────────
const People          = require("./People");
const Message         = require("./Message");
const SalesRep        = require("./SalesRep");
const WhatsAppAccount = require("./WhatsAppAccount");
const AssignmentState = require("./Robin-hood");
const SalesRepPushToken = require("./SalesRepPushToken")(sequelize, DataTypes);
const Escalation      = require("./Escalation");
const Activity        = require("./Activity");
const Event           = require("./Event");
const Integration     = require("./Integration");

// ── Phase 2 new models ────────────────────────────────────────
const AutomationRule  = require("./AutomationRule");
const AutomationLog   = require("./AutomationLog");
const MessageTemplate = require("./MessageTemplate");
const Pipeline        = require("./Pipeline");

// ── Phase 7 — multi-country payment accounts ──────────────────
const PaymentAccount  = require("./PaymentAccount");

// ── Associations ──────────────────────────────────────────────
SalesRep.belongsTo(WhatsAppAccount, { foreignKey: "whatsapp_account_id" });
People.belongsTo(WhatsAppAccount,   { foreignKey: "whatsapp_account_id" });
Message.belongsTo(WhatsAppAccount,  { foreignKey: "whatsapp_account_id" });

SalesRep.hasMany(Message, { foreignKey: "rep_id" });
Message.belongsTo(SalesRep, { foreignKey: "rep_id" });

AssignmentState.belongsTo(SalesRep, {
  foreignKey: "last_rep_id",
  as: "lastAssignedRep",
});

Activity.belongsTo(People, { foreignKey: "lead_id" });
People.hasMany(Activity,   { foreignKey: "lead_id" });

Event.belongsTo(People, { foreignKey: "lead_id" });
People.hasMany(Event,   { foreignKey: "lead_id" });

// Phase 2 associations
AutomationLog.belongsTo(AutomationRule, { foreignKey: "rule_id" });
AutomationRule.hasMany(AutomationLog,   { foreignKey: "rule_id" });

AutomationLog.belongsTo(People, { foreignKey: "lead_id" });
People.hasMany(AutomationLog,   { foreignKey: "lead_id" });

// Pipeline associations
Pipeline.belongsTo(People, { foreignKey: "lead_id" });
People.hasOne(Pipeline,    { foreignKey: "lead_id" });

Pipeline.belongsTo(SalesRep, { foreignKey: "assigned_agent_id", as: "assignedAgent" });
SalesRep.hasMany(Pipeline,   { foreignKey: "assigned_agent_id", as: "pipelineEntries" });

module.exports = {
  sequelize,
  People,
  Lead: People,       // alias — keeps old imports working
  Message,
  SalesRep,
  WhatsAppAccount,
  AssignmentState,
  SalesRepPushToken,
  Escalation,
  // Phase 1
  Activity,
  Event,
  Integration,
  // Phase 2
  AutomationRule,
  AutomationLog,
  MessageTemplate,
  Pipeline,
  // Phase 7
  PaymentAccount,
};
