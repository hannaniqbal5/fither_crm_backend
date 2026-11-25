/**
 * worker.js — the CRM's background worker (database-only jobs).
 *
 * Run it next to the web server:   CRM_PROCESS=worker node src/worker.js
 * and start the web server with:   CRM_PROCESS=web node src/App.js
 * (ecosystem.config.js does both.)
 *
 * WhatsApp-sending jobs (automation engine, campaigns, auto-campaigns,
 * auto-takeover, follow-ups) and the rep-session heartbeat stay in the web
 * process: a WhatsApp session lives in exactly one process. With
 * CRM_PROCESS unset ("all"), the web server runs everything as before.
 * Every job takes a database lock, so running both by mistake is safe.
 */
require("dotenv").config();
process.env.CRM_PROCESS = "worker";

const sequelize = require("./config/database");
require("./monitor/errors").install({ sequelize, role: "worker" });

(async () => {
  await sequelize.authenticate();
  console.log("✅ [worker] Database connected");
  require("./jobs/churnJob").startChurnJob();
  require("./services/owner.service").startOwnerJob();
  require("./broadcast/campaignWeightsJob").startCampaignWeightsJob();
  require("./jobs/repDailySnapshot.job").startDailySnapshotJob();
  require("./jobs/repQualityRules.job").startRepQualityJob();
  require("./jobs/planSync.job").startPlanSyncJob();
  console.log("🛠  [worker] Database-only jobs scheduled. WhatsApp jobs run in the web process.");
})().catch((e) => {
  console.error("[worker] failed to start:", e);
  process.exit(1);
});
