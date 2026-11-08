const { sequelize } = require("../../models");
const { QueryTypes } = require("sequelize");
const { minutesInWindowFast, nextInWindowInstant } = require("../utils/workingHours");

/**
 * Re-compute response time excluding hours outside the 9-9 PKT window.
 * Returns minutes (rounded).
 */
function inWindowMinutes(inboundAt, outboundAt) {
  if (!outboundAt) return null;
  const clampedStart = nextInWindowInstant(inboundAt);
  if (new Date(outboundAt) <= clampedStart) return 0;
  return minutesInWindowFast(clampedStart, new Date(outboundAt));
}

/**
 * GET /api/admin/sales-reps/:salesRepId/performance
 */
exports.getSalesRepPerformance = async (req, res) => {
  try {
    const { salesRepId } = req.params;
    const { date } = req.query;

    const slaMin = parseInt(process.env.REP_SLA_RESPONSE_MINUTES || "5", 10);
    const dateFilter = date ? `AND DATE(in_msg.created_at) = :date` : "";

    // Pull raw paired rows; compute RT in JS so we can clamp to working hours
    const rows = await sequelize.query(
      `SELECT
         in_msg.lead_id,
         in_msg.created_at AS in_at,
         out_msg.created_at AS out_at
       FROM messages in_msg
       LEFT JOIN messages out_msg
         ON in_msg.lead_id = out_msg.lead_id
        AND out_msg.direction = 'OUT'
        AND out_msg.created_at = (
          SELECT MIN(m2.created_at) FROM messages m2
           WHERE m2.lead_id = in_msg.lead_id
             AND m2.direction = 'OUT'
             AND m2.created_at > in_msg.created_at
        )
       JOIN leads l ON l.id = in_msg.lead_id
       WHERE in_msg.direction = 'IN'
         AND l.assigned_to = :salesRepId
         ${dateFilter}`,
      { replacements: { salesRepId, date }, type: QueryTypes.SELECT }
    );

    let totalRt = 0, onTime = 0, missed = 0, samples = 0;
    const leads = new Set();
    rows.forEach(r => {
      leads.add(r.lead_id);
      const rt = inWindowMinutes(r.in_at, r.out_at);
      if (rt == null) { missed += 1; return; }
      samples += 1;
      totalRt += rt;
      if (rt <= slaMin) onTime += 1; else missed += 1;
    });
    const avgRt = samples > 0 ? totalRt / samples : 0;
    const onTimePct = samples > 0 ? (onTime / samples) * 100 : 0;

    res.json({
      sales_rep_id: Number(salesRepId),
      avg_response_time: Number(avgRt.toFixed(1)),
      on_time_percentage: Math.round(onTimePct),
      conversations_handled: leads.size,
      missed_replies: missed,
      sla_minutes: slaMin,
      scoped: "in_working_hours",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch performance" });
  }
};

/**
 * GET /api/admin/sales-reps/performance
 */
exports.getAllSalesRepsPerformance = async (req, res) => {
  try {
    const slaMin = parseInt(process.env.REP_SLA_RESPONSE_MINUTES || "5", 10);

    const rows = await sequelize.query(
      `SELECT
         l.assigned_to AS sales_rep_id,
         in_msg.lead_id,
         in_msg.created_at AS in_at,
         out_msg.created_at AS out_at
       FROM messages in_msg
       JOIN leads l ON l.id = in_msg.lead_id
       LEFT JOIN messages out_msg
         ON in_msg.lead_id = out_msg.lead_id
        AND out_msg.direction = 'OUT'
        AND out_msg.created_at = (
          SELECT MIN(m2.created_at) FROM messages m2
           WHERE m2.lead_id = in_msg.lead_id
             AND m2.direction = 'OUT'
             AND m2.created_at > in_msg.created_at
        )
       WHERE in_msg.direction = 'IN' AND l.assigned_to IS NOT NULL`,
      { type: QueryTypes.SELECT }
    );

    // Aggregate per rep in JS (so we can clamp to working hours)
    const perRep = new Map();
    rows.forEach(r => {
      const key = r.sales_rep_id;
      if (!perRep.has(key)) {
        perRep.set(key, { sales_rep_id: key, totalRt: 0, samples: 0, onTime: 0, missed: 0, leads: new Set() });
      }
      const bucket = perRep.get(key);
      bucket.leads.add(r.lead_id);
      const rt = inWindowMinutes(r.in_at, r.out_at);
      if (rt == null) { bucket.missed += 1; return; }
      bucket.totalRt += rt;
      bucket.samples += 1;
      if (rt <= slaMin) bucket.onTime += 1; else bucket.missed += 1;
    });

    const out = [];
    for (const b of perRep.values()) {
      out.push({
        sales_rep_id: b.sales_rep_id,
        avg_response_time: b.samples > 0 ? Number((b.totalRt / b.samples).toFixed(1)) : 0,
        on_time_percentage: b.samples > 0 ? Math.round((b.onTime / b.samples) * 100) : 0,
        conversations_handled: b.leads.size,
        missed_replies: b.missed,
        sla_minutes: slaMin,
        scoped: "in_working_hours",
      });
    }
    res.json(out);
  } catch (error) {
    console.error("Sales rep performance error:", error);
    res.status(500).json({ error: "Failed to calculate performance" });
  }
};
