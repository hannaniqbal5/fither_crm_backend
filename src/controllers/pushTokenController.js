// const { SalesRepPushToken } = require("../../models");

// exports.registerPushToken = async (req, res) => {
//   try {
//     const salesRepId = req.user.repId;
//     const { token } = req.body;

//     if (!salesRepId || !token) {
//       return res.status(400).json({ message: "Missing data" });
//     }

//     // Check if token already exists
//     const existing = await SalesRepPushToken.findOne({
//       where: { token }
//     });

//     if (existing) {
//       await existing.update({
//         sales_rep_id: salesRepId,
//         last_seen_at: new Date()
//       });
//     } else {
//       await SalesRepPushToken.create({
//         sales_rep_id: salesRepId,
//         token
//       });
//     }

//     return res.status(200).json({ message: "Push token registered" });

//   } catch (error) {
//     console.error("Push token error:", error);
//     return res.status(500).json({ message: "Server error" });
//   }
// };
const { SalesRepPushToken } = require("../../models");

exports.registerPushToken = async (req, res) => {
  try {
    const salesRepId = req.user.repId;
    const { token } = req.body;

    if (!salesRepId || !token) {
      return res.status(400).json({ message: "Missing data" });
    }

    // Check if this exact token already exists (maybe for a different rep)
    const existing = await SalesRepPushToken.findOne({
      where: { token }
    });

    if (existing) {
      // Token exists — update ownership + last_seen
      await existing.update({
        sales_rep_id: salesRepId,
        last_seen_at: new Date()
      });
    } else {
      // New token — save it
      await SalesRepPushToken.create({
        sales_rep_id: salesRepId,
        token
      });
    }

    // Clean up stale tokens for this rep (older than 60 days)
    const { Op } = require("sequelize");
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const deleted = await SalesRepPushToken.destroy({
      where: {
        sales_rep_id: salesRepId,
        last_seen_at: { [Op.lt]: sixtyDaysAgo }
      }
    });
    if (deleted > 0) {
      console.log(`🗑️  Cleaned up ${deleted} stale push token(s) for rep ${salesRepId}`);
    }

    return res.status(200).json({ message: "Push token registered" });

  } catch (error) {
    console.error("Push token error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};