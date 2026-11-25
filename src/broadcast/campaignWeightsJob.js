/**
 * campaignWeightsJob.js — Phase 19d
 *
 * Every 30 min: scores each running campaign, converts scores to send
 * weights (clamped to [25%, 75%] per group), and writes them back to
 * `campaigns.current_weight`. broadcastWorker reads `current_weight`
 * when choosing which campaign sends the next message.
 *
 * Groups campaigns by whatsapp_account_id — weights sum to 1.0 within
 * each WA-account group independently.
 *
 * Score formula:
 *   score = (reply_rate × 100) − (optout_rate × 50) − (fail_rate × 30)
 *
 * Cold-start handling: campaigns with sample < weights_min_sample get
 * neutral weight (1 / N_in_group), so they still get a fair test before
 * being judged.
 */

const sequelize = require("../config/database");

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let jobRunning = false;

async function loadSettings() {
  try {
    const [rows] = await sequelize.query(
      `SELECT setting_key, setting_value FROM layer_system_settings
        WHERE setting_key IN
          ('weights_min_pct','weights_max_pct','weights_min_sample','weights_cold_start_weight')`
    );
    const m = {};
    rows.forEach((r) => { m[r.setting_key] = r.setting_value; });
    return {
      minPct:           parseFloat(m.weights_min_pct           || "25") / 100,
      maxPct:           parseFloat(m.weights_max_pct           || "75") / 100,
      minSample:        parseInt(m.weights_min_sample           || "20", 10),
      coldStartPct:     parseFloat(m.weights_cold_start_weight || "50") / 100,
    };
  } catch {
    return { minPct: 0.25, maxPct: 0.75, minSample: 20, coldStartPct: 0.5 };
  }
}

/**
 * Compute scores for all running campaigns and persist current_weight.
 * Groups by whatsapp_account_id (NULL grouped together).
 */
async function recomputeWeights() {
  const settings = await loadSettings();

  // Pull all running campaigns with their current stats
  const [campaigns] = await sequelize.query(
    `SELECT campaign_id, name, whatsapp_account_id, current_weight,
            sent_count, replied_count, failed_count
       FROM campaigns
      WHERE status = 'running'`
  );
  if (campaigns.length === 0) return { groups: 0, updated: 0 };

  // Pull opt-out counts per campaign in one go
  const [optoutRows] = await sequelize.query(
    `SELECT campaign_id, COUNT(*) AS optouts
       FROM campaign_recipients
      WHERE status = 'opted_out'
      GROUP BY campaign_id`
  );
  const optoutMap = {};
  optoutRows.forEach((r) => { optoutMap[r.campaign_id] = Number(r.optouts || 0); });

  // Score each campaign
  const scored = campaigns.map((c) => {
    const sent     = Number(c.sent_count || 0);
    const replied  = Number(c.replied_count || 0);
    const failed   = Number(c.failed_count || 0);
    const optouts  = optoutMap[c.campaign_id] || 0;

    const reply_rate  = sent > 0 ? (replied / sent) : 0;
    const optout_rate = sent > 0 ? (optouts / sent) : 0;
    const fail_rate   = sent > 0 ? (failed  / sent) : 0;

    const score = (reply_rate * 100) - (optout_rate * 50) - (fail_rate * 30);

    return {
      ...c,
      sample: sent,
      reply_rate, optout_rate, fail_rate,
      score,
      coldStart: sent < settings.minSample,
    };
  });

  // Group by WA account
  const groups = {};
  for (const c of scored) {
    const key = c.whatsapp_account_id ?? "null";
    (groups[key] = groups[key] || []).push(c);
  }

  let updates = 0;

  for (const key of Object.keys(groups)) {
    const group = groups[key];
    const N = group.length;
    if (N === 0) continue;

    // 1) Initial weights:
    //    - cold-start campaigns get the coldStartPct base
    //    - mature campaigns get their score (shifted to be non-negative)
    const minScore = Math.min(...group.map((g) => g.coldStart ? -Infinity : g.score));
    const shift = Number.isFinite(minScore) && minScore < 0 ? Math.abs(minScore) + 1 : 0;

    let raw = group.map((g) => {
      if (g.coldStart) return settings.coldStartPct;
      return Math.max(0.01, g.score + shift); // ensure positive
    });

    // 2) Normalize to sum to 1
    let total = raw.reduce((a, b) => a + b, 0);
    if (total <= 0) total = 1;
    let weights = raw.map((w) => w / total);

    // 3) Apply min/max clamp, then re-normalize
    //    Iterate up to 5 times so clamping converges (clamping changes the sum)
    for (let iter = 0; iter < 5; iter++) {
      let changed = false;
      weights = weights.map((w) => {
        if (w < settings.minPct) { changed = true; return settings.minPct; }
        if (w > settings.maxPct) { changed = true; return settings.maxPct; }
        return w;
      });
      total = weights.reduce((a, b) => a + b, 0);
      if (total <= 0) total = 1;
      weights = weights.map((w) => w / total);
      if (!changed) break;
    }

    // 4) Special case: if there's only ONE campaign in the group, weight = 1.0
    if (N === 1) weights = [1.0];

    // 5) Persist + audit
    for (let i = 0; i < group.length; i++) {
      const c = group[i];
      const newW = Math.round(weights[i] * 10000) / 10000;
      const oldW = c.current_weight == null ? null : Number(c.current_weight);

      await sequelize.query(
        `UPDATE campaigns
            SET health_score = :score,
                current_weight = :w,
                weights_recomputed_at = NOW()
          WHERE campaign_id = :id`,
        { replacements: { id: c.campaign_id, score: c.score.toFixed(3), w: newW } }
      );

      // Only audit if weight changed meaningfully
      if (oldW === null || Math.abs(newW - oldW) >= 0.01) {
        await sequelize.query(
          `INSERT INTO campaign_weight_history
             (campaign_id, whatsapp_account_id, health_score,
              weight_before, weight_after,
              reply_rate, optout_rate, fail_rate, sample_size)
           VALUES (:id, :wa, :score, :ob, :nb, :rr, :or_, :fr, :ss)`,
          {
            replacements: {
              id: c.campaign_id,
              wa: c.whatsapp_account_id,
              score: c.score.toFixed(3),
              ob: oldW, nb: newW,
              rr: c.reply_rate.toFixed(3),
              or_: c.optout_rate.toFixed(3),
              fr: c.fail_rate.toFixed(3),
              ss: c.sample,
            },
          }
        );
      }

      updates++;
    }

    console.log(
      `📊 [campaignWeightsJob] WA=${key} (${N} campaign(s)): ` +
      group.map((g, i) => `${g.name}=${(weights[i] * 100).toFixed(0)}%`).join(", ")
    );
  }

  return { groups: Object.keys(groups).length, updated: updates };
}

async function tick() {
  if (jobRunning) return;
  jobRunning = true;
  try {
    const result = await recomputeWeights();
    if (result.updated > 0) {
      console.log(`✅ [campaignWeightsJob] recomputed ${result.updated} weight(s) across ${result.groups} group(s)`);
    }
  } catch (err) {
    console.error("❌ [campaignWeightsJob] error:", err.message);
  } finally {
    jobRunning = false;
  }
}

function startCampaignWeightsJob() {
  // Run once shortly after boot, then every 30 min
  const job = require("../monitor/jobs").wrap("campaign-weights", tick);
  setTimeout(job, 60 * 1000);
  setInterval(job, POLL_INTERVAL_MS);
  console.log(`🧠 [campaignWeightsJob] started — recompute every ${POLL_INTERVAL_MS / 60000} min`);
}

module.exports = { startCampaignWeightsJob, recomputeWeights, tick };
