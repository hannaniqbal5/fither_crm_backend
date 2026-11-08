const adminService = require("./admin.service");

/* =========================
   DASHBOARD
========================= */
exports.dashboard = async (req, res) => {
  try {
    const data = await adminService.dashboard();
    res.json(data);
  } catch (err) {
    console.error("❌ Admin dashboard error:", err);
    res.status(500).json({ error: "Failed to fetch dashboard" });
  }
};

/* =========================
   LEADS
========================= */
exports.getLeads = async (req, res) => {
  try {
    const leads = await adminService.getLeads();
    res.json(leads);
  } catch (err) {
    console.error("❌ Admin getLeads error:", err);
    res.status(500).json({ error: "Failed to fetch leads" });
  }
};

exports.getLeadDetails = async (req, res) => {
  try {
    const lead = await adminService.getLeadDetails(req.params.id);
    res.json(lead);
  } catch (err) {
    console.error("❌ Admin getLeadDetails error:", err);
    res.status(err.message === "Lead not found" ? 404 : 500).json({ error: err.message });
  }
};

/* =========================
   MEDIA / VOICE
========================= */
exports.getMediaLogs = async (req, res) => {
  try {
    const media = await adminService.getMediaLogs();
    res.json(media);
  } catch (err) {
    console.error("❌ Admin getMediaLogs error:", err);
    res.status(500).json({ error: "Failed to fetch media logs" });
  }
};

/* =========================
   SALES TEAM
========================= */

exports.getSalesTeam = async (req, res) => {
    try {
      const data = await adminService.getSalesTeamData();
      res.json(data);
    } catch (err) {
      console.error("❌ Admin Sales Team Error:", err);
      res.status(500).json({ error: err.message });
    }
};

/* =========================
   ANALYTICS
========================= */
exports.getAnalytics = async (req, res) => {
  try {
    const analytics = await adminService.getAnalytics();
    res.json(analytics);
  } catch (err) {
    console.error("❌ Admin getAnalytics error:", err);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
};

exports.getConversations = async (req, res) => {
  try {
    const data = await adminService.getConversations();
    res.json(data);
  } catch (err) {
    console.error("❌ Admin getConversations error:", err);
    res.status(500).json({ error: "Failed to fetch conversations" });
  }
};