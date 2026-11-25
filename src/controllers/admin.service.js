const { People, Message, SalesRep, sequelize } = require("../../models");
const { withLifecycle, withLifecycleAll } = require("../utils/lifecycle");
const { QueryTypes, Op } = require("sequelize");

/* =========================
   DASHBOARD
========================= */
exports.dashboard = async () => {
  const [totalPeople, totalMessages, activePeople] = await Promise.all([
    People.count(),
    Message.count(),
    People.count({ where: { stage: ["lead", "user"] } }),
  ]);
  return { totalPeople, totalMessages, activePeople };
};

/* =========================
   ALL PEOPLE (admin view)
========================= */
exports.getLeads = async () => {
  // Exclude app-support contacts — they live in the dedicated "App Issues"
  // section, not the sales Leads list. (source IS NULL still shows, just not 'app'.)
  const rows = await People.findAll({
    where: { source: { [Op.or]: [{ [Op.ne]: "app" }, { [Op.is]: null }] } },
    include: [{ model: SalesRep, as: "SalesRep", attributes: ["id", "name", "email"] }],
    order: [["last_message_at", "DESC"]],
  });
  return withLifecycleAll(rows.map(r => r.toJSON ? r.toJSON() : r));
};

/* =========================
   PERSON DETAIL + MESSAGES
========================= */
exports.getLeadDetails = async (personId) => {
  const person = await People.findByPk(personId, {
    include: [{ model: SalesRep, as: "SalesRep", attributes: ["id", "name", "email"] }],
  });
  if (!person) throw new Error("Lead not found");

  const messages = await Message.findAll({
    where: { lead_id: personId },
    order: [["created_at", "ASC"]],
    limit: 500,
  });

  const enriched = withLifecycle(person.toJSON ? person.toJSON() : person);
  return { person: enriched, messages };
};

/* =========================
   ANALYTICS
========================= */
exports.getAnalytics = async () => {
  const [byStage, bySource, bySalesRep, dailyMessages] = await Promise.all([
    // People by stage
    sequelize.query(
      `SELECT stage, COUNT(*) as count FROM leads GROUP BY stage`,
      { type: QueryTypes.SELECT }
    ),
    // People by source
    sequelize.query(
      `SELECT source, COUNT(*) as count FROM leads GROUP BY source`,
      { type: QueryTypes.SELECT }
    ),
    // People per sales rep
    sequelize.query(
      `SELECT sr.name, COUNT(l.id) as people_count
       FROM sales_reps sr
       LEFT JOIN leads l ON l.assigned_to = sr.id
       GROUP BY sr.id, sr.name`,
      { type: QueryTypes.SELECT }
    ),
    // Daily message volume (last 7 days)
    sequelize.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM messages
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      { type: QueryTypes.SELECT }
    ),
  ]);

  return { byStage, bySource, bySalesRep, dailyMessages };
};
