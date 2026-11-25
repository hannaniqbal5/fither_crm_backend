/**
 * automationMetrics.routes.js — Manager metrics for auto campaigns + takeover.
 *
 * Single endpoint that returns everything the manager dashboard needs.
 */

const router = require("express").Router();
const sequelize = require("../config/database");

router.get("/automation-metrics", async (req, res) => {
  try {
    // Auto campaign stats (today + last 7 days)
    const [campaignToday] = await sequelize.query(`
      SELECT status, COUNT(*) AS count
      FROM auto_campaign_sends
      WHERE DATE(sent_at) = CURDATE()
      GROUP BY status
    `);

    const [campaignWeekly] = await sequelize.query(`
      SELECT DATE(sent_at) AS day, status, COUNT(*) AS count
      FROM auto_campaign_sends
      WHERE sent_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY DATE(sent_at), status
      ORDER BY day
    `);

    const [campaignTopRules] = await sequelize.query(`
      SELECT r.name, r.trigger_event,
        SUM(CASE WHEN s.status = 'sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN s.status = 'skipped' THEN 1 ELSE 0 END) AS skipped
      FROM auto_campaign_rules r
      LEFT JOIN auto_campaign_sends s ON s.rule_id = r.id AND s.sent_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      WHERE r.is_active = 1
      GROUP BY r.id
      ORDER BY sent DESC
    `);

    // Takeover stats
    const [takeoverToday] = await sequelize.query(`
      SELECT action_taken, COUNT(*) AS count
      FROM auto_takeover_log
      WHERE DATE(created_at) = CURDATE()
      GROUP BY action_taken
    `);

    const [takeoverWeekly] = await sequelize.query(`
      SELECT DATE(created_at) AS day, action_taken, COUNT(*) AS count
      FROM auto_takeover_log
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY DATE(created_at), action_taken
      ORDER BY day
    `);

    const [avgRepResponseTime] = await sequelize.query(`
      SELECT AVG(wait_actual_min) AS avg_wait_min
      FROM auto_takeover_log
      WHERE action_taken = 'replied'
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
    `);

    const [takeoverSkipReasons] = await sequelize.query(`
      SELECT skip_reason, COUNT(*) AS count
      FROM auto_takeover_log
      WHERE action_taken = 'skipped'
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY skip_reason ORDER BY count DESC
    `);

    // Active rules count
    const [activeCounts] = await sequelize.query(`
      SELECT
        (SELECT COUNT(*) FROM auto_campaign_rules WHERE is_active = 1) AS active_campaigns,
        (SELECT COUNT(*) FROM auto_takeover_rules WHERE is_active = 1) AS active_takeovers
    `);

    // Rep performance — avg time to first reply today
    const [repSpeed] = await sequelize.query(`
      SELECT r.name AS rep_name, r.id AS rep_id,
        AVG(TIMESTAMPDIFF(MINUTE, m_in.created_at,
          (SELECT MIN(m_out.created_at) FROM messages m_out
           WHERE m_out.lead_id = m_in.lead_id AND m_out.\`from\` = 'rep'
             AND m_out.created_at > m_in.created_at)
        )) AS avg_reply_min
      FROM messages m_in
      INNER JOIN leads l ON l.id = m_in.lead_id
      INNER JOIN sales_reps r ON r.id = l.assigned_to
      WHERE m_in.direction = 'IN'
        AND m_in.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      GROUP BY r.id
      ORDER BY avg_reply_min ASC
    `);

    res.json({
      campaign: {
        today: campaignToday,
        weekly: campaignWeekly,
        topRules: campaignTopRules,
      },
      takeover: {
        today: takeoverToday,
        weekly: takeoverWeekly,
        avgWaitMin: avgRepResponseTime[0]?.avg_wait_min || null,
        skipReasons: takeoverSkipReasons,
      },
      active: activeCounts[0] || {},
      repSpeed,
    });
  } catch (e) {
    console.error("[AutomationMetrics] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
