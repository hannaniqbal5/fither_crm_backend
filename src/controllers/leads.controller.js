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

    // Reply the way she came (Nov 2026): if her latest message came from the
    // app / web chat — or she has no WhatsApp at all — the reply goes to her
    // app chat (+ a push), not to WhatsApp.
    const [[lastIn]] = await db.query(
      "SELECT channel FROM messages WHERE lead_id = :id AND direction = 'IN' ORDER BY id DESC LIMIT 1",
      { replacements: { id: person.id } }
    );
    if ((lastIn && lastIn.channel === "app") || (!person.whatsapp_jid && person.app_user_id)) {
      return sendToAppChat(req, res, person, message, client_id);
    }
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
    return res.status(500).json({ error: "Failed to send message", ...(process.env.NODE_ENV !== "production" ? { detail: err.message } : {}) });
  }
};

// Rep reply into her app / web chat: save it (channel 'app'), ask
// partner_backend to push it to her phone, update the rep's screen.
async function sendToAppChat(req, res, person, message, client_id) {
  const repId = req.user.repId;
  const [ins] = await db.query(
    "INSERT INTO messages (lead_id, rep_id, whatsapp_account_id, `from`, message, direction, message_type, channel, status, is_read, created_at, updated_at) " +
      "VALUES (:lead, :rep, :acc, 'rep', :msg, 'OUT', 'text', 'app', 'sent', 1, NOW(), NOW())",
    { replacements: { lead: person.id, rep: repId, acc: person.whatsapp_account_id || 1, msg: message } }
  );
  const id = require("../utils/insertId").insertIdOf(ins);
  await db.query("UPDATE leads SET last_message_at = NOW(), last_activity_at = NOW() WHERE id = :id", { replacements: { id: person.id } });
  const [[row]] = await db.query("SELECT * FROM messages WHERE id = :id", { replacements: { id } });

  let pushed = false;
  const url = process.env.APP_NOTIFY_URL, secret = process.env.APP_WEBHOOK_SECRET;
  if (person.app_user_id && url && secret && process.env.OUTBOUND_DISABLED !== "1") {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": secret },
        body: JSON.stringify({ app_user_id: person.app_user_id, title: "Your coach replied 💬", body: String(message).slice(0, 200), data: { type: "coach_chat", lead_id: String(person.id) } }),
      });
      pushed = r.ok;
    } catch (e) { console.error("[app-chat] push failed:", e.message); }
  }
  const io = req.app.get("io");
  io && io.to(`rep_${repId}`).emit("newMessage", { ...row, client_id: client_id || null });
  return res.json({ success: true, channel: "app", pushed });
}

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
