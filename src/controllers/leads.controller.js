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
  const { message: saved } = await require("../services/frontDesk").saveMessage({
    contact: person, direction: "OUT", channel: "app", from: "rep", text: message,
    accountId: person.whatsapp_account_id || 1, repId,
  });
  const id = saved.id;
  await db.query("UPDATE leads SET last_activity_at = NOW() WHERE id = :id", { replacements: { id: person.id } });
  const [[row]] = await db.query("SELECT * FROM messages WHERE id = :id", { replacements: { id } });

  const { pushToApp } = require("../services/appPush");
  const { pushed } = await pushToApp({
    appUserId: person.app_user_id,
    title: "Your coach replied 💬",
    body: String(message).slice(0, 200),
    data: { type: "coach_chat", lead_id: String(person.id) },
  });
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

// ── Start a chat with a number that isn't a contact yet ───────────
/**
 * POST /leads/start-chat   { phone, message, whatsapp_account_id? }
 *
 * The CRM could only ever message a woman who was already a contact — every
 * other send path begins with People.findByPk(leadId). So reaching a new
 * number meant either an admin typing it into the Fizza Chats panel, or a rep
 * picking up the shared WhatsApp phone, which until now saved nothing at all.
 *
 * This is the proper door for it, open to admins and reps alike. It also fixes
 * the ownership guess: when a rep starts the chat here we KNOW who they are, so
 * she is assigned to the rep who actually reached out, instead of whoever round
 * robin happened to land on.
 */
exports.startChat = async (req, res) => {
  try {
    const frontDesk = require("../services/frontDesk");
    const whatsapp  = require("../channels/whatsappChannel");
    const { isAdmin } = require("../middleware/leadOwnership");

    const repId = req.user?.repId;
    const admin = isAdmin(req);
    const { phone, message, whatsapp_account_id } = req.body || {};

    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.length < 10) {
      return res.status(400).json({ error: "A valid phone number is required" });
    }
    const body = String(message || "").trim();
    if (!body) {
      return res.status(400).json({ error: "A message is required" });
    }

    // Which of your numbers this goes out from. A rep always sends from their
    // own, so her reply lands back in that rep's account-filtered inbox.
    // Only an admin may choose a different one.
    const accountId = Number(
      (admin && whatsapp_account_id) || req.user?.whatsappAccountId || whatsapp_account_id || 0
    );
    if (!accountId) {
      return res.status(400).json({ error: "No WhatsApp account for this user" });
    }

    // One door in. Matches her on the last 10 digits first, so typing the
    // number a different way doesn't create a second contact.
    const { contact, isNew } = await frontDesk.findOrCreateContact({
      channel:    "whatsapp",
      identity:   `${digits}@s.whatsapp.net`,
      accountId,
      phone:      digits,
      repId:      repId || null,
      loosePhone: true,
      source:     "whatsapp",
      gate:       "crm_start_chat",
    });

    // She already exists and belongs to someone else: don't let two reps work
    // the same woman. Admins may proceed.
    if (!isNew && contact.assigned_to && Number(contact.assigned_to) !== Number(repId) && !admin) {
      return res.status(409).json({
        error: "Another rep already has this contact",
        lead_id: contact.id,
        assigned_to: contact.assigned_to,
      });
    }

    // She exists but nobody owns her: the rep reaching out now owns her.
    if (!isNew && !contact.assigned_to && repId) {
      try { await contact.update({ assigned_to: repId }); }
      catch (e) { console.warn("[startChat] could not claim contact:", e.message); }
    }

    // Never message a woman who asked us to stop.
    if (await frontDesk.isSilenced(contact)) {
      return res.status(403).json({
        error: "This contact has opted out and must not be messaged",
        lead_id: contact.id,
      });
    }

    const sent = await whatsapp.send(contact, body);
    if (!sent.success) {
      // She is saved either way — we just couldn't reach her yet.
      return res.status(502).json({
        error: sent.error || "WhatsApp send failed",
        lead_id: contact.id,
        created: isNew,
      });
    }

    // One door out.
    const { message: saved } = await frontDesk.saveMessage({
      contact,
      direction: "OUT",
      channel:   "whatsapp",
      from:      "rep",
      text:      body,
      accountId,
      externalMessageId: sent.messageId,
      repId:     repId || contact.assigned_to || null,
    });

    const io = req.app.get("io");
    if (io) {
      const owner = contact.assigned_to || repId;
      if (owner) io.to(`rep_${owner}`).emit("newMessage", saved);
      io.to("admins").emit("newMessage", saved);
    }

    return res.json({
      success: true,
      created: isNew,
      lead_id: contact.id,
      message_id: saved.id,
      // The dashboard opens her chat straight away, so give it enough to
      // render the row before the leads list has refreshed.
      phone: contact.phone,
      name: contact.name || null,
      assigned_to: contact.assigned_to || repId || null,
      whatsapp_account_id: accountId,
    });
  } catch (err) {
    console.error("❌ [startChat] failed:", err);
    return res.status(500).json({ error: err.message });
  }
};

// ── Edit a contact's basic details (name, email) ──────────────────
/**
 * PATCH /leads/:id/details   { name?, email? }
 *
 * `leads.email` has existed since migration 001 and is indexed, but nothing
 * ever filled it for a woman who arrived on WhatsApp or Instagram: only the
 * app integration wrote it, and only for women already linked. So email was
 * dead as a way of recognising the same woman on both sides, which is why the
 * backfill matched 0 by email.
 *
 * Phone is the only other key, and app users who sign in with Google or Apple
 * often have no phone at all. Letting a rep type the address she already knows
 * is the cheapest way to make those women linkable.
 *
 * If the address already belongs to someone else we refuse and file a match
 * suggestion, so it surfaces in the duplicates queue instead of silently
 * creating two women with one email.
 */
exports.updateDetails = async (req, res) => {
  try {
    const frontDesk = require("../services/frontDesk");
    const { isAdmin } = require("../middleware/leadOwnership");

    const lead = await People.findByPk(req.params.id);
    if (!lead) return res.status(404).json({ message: "Person not found" });
    if (!assertOwnsOr403(req, res, lead)) return;

    const patch = {};
    const { name, email } = req.body || {};

    if (name !== undefined) {
      const clean = String(name || "").trim().slice(0, 120);
      patch.name = clean || null;
    }

    if (email !== undefined) {
      if (email === null || String(email).trim() === "") {
        patch.email = null;
      } else {
        const clean = frontDesk.normalizeEmail(email);
        if (!clean) return res.status(400).json({ error: "That doesn't look like an email address" });

        // Already on another contact? Don't create a second woman with one address.
        const [dupes] = await db.query(
          `SELECT id, name, phone, app_user_id FROM leads
            WHERE email = ? AND id <> ? AND merged_into_lead_id IS NULL
            LIMIT 1`,
          { replacements: [clean, lead.id] }
        );
        if (dupes.length) {
          const other = dupes[0];
          // Feed the existing duplicates queue so a human can merge them.
          // That table's convention is lead_id = the app-linked side, so put
          // whichever of the two carries an app_user_id first; otherwise the
          // merge screen reads the pair backwards.
          const appSide = other.app_user_id ? other.id : lead.id;
          const otherSide = other.app_user_id ? lead.id : other.id;
          await db.query(
            `INSERT IGNORE INTO lead_match_suggestions (lead_id, candidate_lead_id, reason, detail)
             VALUES (?, ?, 'email', ?)`,
            { replacements: [appSide, otherSide, `rep entered ${clean} on lead #${lead.id}; already on #${other.id}`] }
          ).catch(() => {});
          return res.status(409).json({
            error: "Another contact already has that email",
            lead_id: lead.id,
            other_lead_id: other.id,
            other_is_app_linked: !!other.app_user_id,
            hint: "Filed in the duplicates queue — merge them instead of entering it twice",
          });
        }
        patch.email = clean;
      }
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: "Nothing to update. Send name and/or email." });
    }

    await lead.update(patch);

    const io = req.app.get("io");
    if (io) {
      const payload = { lead_id: lead.id, name: lead.name, email: lead.email };
      if (lead.assigned_to) io.to(`rep_${lead.assigned_to}`).emit("leadUpdated", payload);
      io.to("admins").emit("leadUpdated", payload);
    }

    return res.json({
      success: true,
      lead_id: lead.id,
      name: lead.name,
      email: lead.email,
      updated_by: isAdmin(req) ? "admin" : `rep_${req.user?.repId}`,
    });
  } catch (err) {
    console.error("❌ [updateDetails] failed:", err);
    return res.status(500).json({ error: err.message });
  }
};
