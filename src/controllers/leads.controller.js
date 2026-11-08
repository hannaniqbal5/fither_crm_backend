const { People, Message } = require("../../models");
const { saveMessage } = require("../whatsapp/message.service");
const { getBaileysClient } = require("../whatsapp/baileysClient");
const db = require("../config/database");
const { getNextRepRoundRobin } = require("../services/assignment.service");
const onlineUsers = require("../../socket/onlineUsers");
const { sendPushToSalesRep } = require("../services/notificationService");
const { assertOwnsOr403 } = require("../middleware/leadOwnership");

// ── Assign person (round-robin) ───────────────────────────────
exports.assignLead = async (req, res) => {
  try {
    const { leadId } = req.body;
    if (!leadId) return res.status(400).json({ message: "leadId is required" });

    const person = await People.findByPk(leadId);
    if (!person) return res.status(404).json({ message: "Person not found" });

    // Round-robin within the lead's own WhatsApp account so the reassigned rep
    // can actually see the lead and reply from the correct number.
    const nextRep = await getNextRepRoundRobin(person.whatsapp_account_id);
    if (!nextRep) return res.status(400).json({ message: "No active sales rep found" });

    const salesRepId = nextRep.id;

    await db.execute("UPDATE leads SET assigned_to = ? WHERE id = ?", [salesRepId, leadId]);

    const payload = {
      id: person.id,
      phone: person.phone,
      status: person.status,
      stage: person.stage,
      unread_count: person.unread_count || 0,
      last_message_at: person.last_message_at,
      source: person.source,
      whatsapp_account_id: person.whatsapp_account_id,
    };

    if (onlineUsers[salesRepId]) {
      onlineUsers[salesRepId].emit("personAssigned", payload);
      console.log(`🟢 [Rep ${salesRepId}] FOREGROUND → using SOCKET`);
    } else {
      console.log(`📤 [Rep ${salesRepId}] DISCONNECTED → using FIREBASE`);
      await sendPushToSalesRep(salesRepId, "New WhatsApp Lead", `Lead #${person.id} assigned to you`);
    }

    return res.status(200).json({ message: "Person assigned successfully", assignedTo: salesRepId });
  } catch (error) {
    console.error("❌ Assign person error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ── Send text message ─────────────────────────────────────────
exports.sendMessage = async (req, res) => {
  try {
    const { message, lead_id, client_id } = req.body;

    if (!lead_id || !message) {
      return res.status(400).json({ error: "lead_id and message are required" });
    }

    const repId = req.user.repId;

    const person = await People.findByPk(lead_id);
    if (!person) return res.status(404).json({ error: "Person not found" });
    if (person.assigned_to !== repId) return res.status(403).json({ error: "Not your lead" });
    if (!person.whatsapp_jid) return res.status(400).json({ error: "Person has no WhatsApp JID" });

    // Always reply from the SAME WhatsApp number the lead belongs to — not the
    // rep's default account. With multiple connected accounts these can differ,
    // and sending from the wrong socket would deliver from the wrong number.
    const whatsappAccountId = person.whatsapp_account_id;

    const sock = getBaileysClient(whatsappAccountId);
    if (!sock) return res.status(400).json({ error: "WhatsApp not connected" });

    const { message: dbMessage } = await saveMessage({
      lead_id,
      phone: person.phone || null,
      whatsapp_jid: person.whatsapp_jid,
      repId,
      whatsappAccountId,
      from: "rep",
      message,
      direction: "OUT",
      status: "sending",
      message_type: "text",
      client_id,
    });

    let result;
    try {
      result = await sock.sendMessage(person.whatsapp_jid, { text: message });
    } catch (sendErr) {
      // WhatsApp didn't take it — drop the placeholder row so the chat history
      // doesn't show a phantom "sending" copy next to the rep's retry.
      await dbMessage.destroy().catch(() => {});
      throw sendErr;
    }

    await dbMessage.update({
      status: "sent",
      whatsapp_message_id: result?.key?.id || null,
    });

    const io = req.app.get("io");
    // Echo client_id (not a DB column, so saveMessage drops it) so the
    // dashboard can swap its optimistic bubble for the saved message.
    io.to(`rep_${repId}`).emit("newMessage", { ...dbMessage.toJSON(), client_id: client_id || null });

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Send message error:", err);
    return res.status(500).json({ error: "Failed to send message" });
  }
};

// ── Get all people for this rep ───────────────────────────────
exports.getLeads = async (req, res) => {
  try {
    const people = await People.findAll({
      where: {
        assigned_to: req.user.repId,
        whatsapp_account_id: req.user.whatsappAccountId,
      },
      order: [["last_message_at", "DESC"]],
    });
    res.json(people);
  } catch (err) {
    console.error("❌ Fetch people error:", err);
    res.status(500).json({ error: "Failed to fetch people" });
  }
};

// ── Get messages for a person ─────────────────────────────────
exports.getMessages = async (req, res) => {
  try {
    const { leadId } = req.params;
    const repId = req.user.repId;

    // Admins can open ANY conversation (incl. unassigned app-support issues).
    // Reps are still restricted to leads assigned to them.
    const where = { id: leadId };
    if (req.user.role !== "admin") where.assigned_to = repId;

    const person = await People.findOne({ where });
    if (!person) return res.status(403).json({ error: "Access denied or person not found" });

    const messages = await Message.findAll({
      where: { lead_id: leadId },
      order: [["created_at", "ASC"]],
      limit: 200,
    });

    res.json({ data: messages });
  } catch (err) {
    console.error("❌ Fetch messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
};

// ── Update person status ──────────────────────────────────────
exports.updateLeadStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const repId = req.user.repId;

    const allowedStatuses = ["new", "interested", "followup", "converted", "lost"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const person = await People.findOne({ where: { id, assigned_to: repId } });
    if (!person) return res.status(404).json({ message: "Person not found or access denied" });

    person.status = status;
    await person.save();

    const io = req.app.get("io");
    if (io) io.emit("personStatusUpdated", { lead_id: person.id, status });

    res.json({ success: true, lead: person });
  } catch (err) {
    console.error("Update person status error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ── Unread messages ───────────────────────────────────────────
exports.getUnreadMessages = async (req, res) => {
  try {
    const repId = req.user.repId;
    const unread = await Message.findAll({
      where: { rep_id: repId, direction: "IN", is_read: false },
      order: [["createdAt", "ASC"]],
    });
    res.json(unread);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Mark lead as read ─────────────────────────────────────────
exports.markLeadAsRead = async (req, res) => {
  try {
    const { leadId } = req.params;

    const person = await People.findByPk(leadId);
    if (!person) return res.status(404).json({ message: "Person not found" });
    if (!assertOwnsOr403(req, res, person)) return;

    const [updatedRows] = await Message.update(
      { is_read: true },
      { where: { lead_id: leadId, direction: "IN", is_read: false } }
    );

    await People.update({ unread_count: 0 }, { where: { id: leadId } });

    console.log("Rows updated:", updatedRows);
    res.json({ message: "Messages marked as read" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};
