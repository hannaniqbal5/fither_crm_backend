const { SalesRep, People, Message, sequelize } = require("../../models");

exports.getDashboardStats = async (req, res) => {
  try {
    const reps = await SalesRep.findAll({ attributes: ["id", "name", "email"] });
    const data = [];

    for (const rep of reps) {
      const [totalPeople, adPeople, interestedPeople, receivedMsgs, sentMsgs] =
        await Promise.all([
          People.count({ where: { assigned_to: rep.id } }),
          People.count({ where: { assigned_to: rep.id, source: "ad" } }),
          People.count({ where: { assigned_to: rep.id, status: "interested" } }),
          Message.count({ where: { rep_id: rep.id, direction: "IN" } }),
          Message.count({ where: { rep_id: rep.id, direction: "OUT" } }),
        ]);

      data.push({
        repId: rep.id,
        name: rep.name,
        email: rep.email,
        totalPeople,
        adPeople,
        interestedPeople,
        messagesReceived: receivedMsgs,
        messagesSent: sentMsgs,
      });
    }

    res.json(data);
  } catch (err) {
    console.error("❌ Admin dashboard error:", err);
    res.status(500).json({ error: "Dashboard fetch failed" });
  }
};
