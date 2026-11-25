/**
 * PM2 Ecosystem Config — FitHer CRM
 * Keeps Node.js + Baileys alive 24/7 on Hostinger VPS
 *
 * Usage:
 *   pm2 start ecosystem.config.js          # start
 *   pm2 restart fithercrm                  # restart
 *   pm2 logs fithercrm                     # live logs
 *   pm2 save && pm2 startup                # survive reboot
 */
module.exports = {
  apps: [
    {
      name:        "fithercrm",
      script:      "src/App.js",
      instances:   1,            // single instance — Baileys session is not shareable
      autorestart: true,
      watch:       false,        // never watch in production
      max_memory_restart: "500M",

      env: {
        NODE_ENV: "development",
        PORT:     4000,
        CRM_PROCESS: "web",   // WhatsApp + the jobs that send WhatsApp
      },

      env_production: {
        NODE_ENV: "production",
        PORT:     4000,
        CRM_PROCESS: "web",
      },

      // Log files
      out_file:   "./logs/out.log",
      error_file: "./logs/error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",

      // Restart policy — exponential backoff up to 60s
      exp_backoff_restart_delay: 100,

      // Graceful shutdown
      kill_timeout: 5000,
    },
    {
      // Database-only jobs (churn, owner tasks, campaign weights, rep
      // snapshot/quality, nightly plan sync). See src/worker.js.
      name:        "fithercrm-worker",
      script:      "src/worker.js",
      instances:   1,
      autorestart: true,
      watch:       false,
      max_memory_restart: "300M",
      env:            { NODE_ENV: "development", CRM_PROCESS: "worker" },
      env_production: { NODE_ENV: "production",  CRM_PROCESS: "worker" },
      out_file:   "./logs/worker-out.log",
      error_file: "./logs/worker-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      exp_backoff_restart_delay: 100,
      kill_timeout: 5000,
    },
  ],
};
