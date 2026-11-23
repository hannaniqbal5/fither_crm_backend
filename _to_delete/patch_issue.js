const fs=require("fs");const p=process.argv[2]+"/controllers/FrontSite/appIssueController.js";let s=fs.readFileSync(p,"utf8");
const a=`    const now = new Date();
    const ticket = await SupportTicket.create({`;
const startIdx=s.indexOf(a); if(startIdx<0) throw "start";
const endMarker=`    if (synced) {
      ticket.crmSynced = true;
      await ticket.save();
    }
`;
const endIdx=s.indexOf(endMarker,startIdx); if(endIdx<0) throw "end";
s=s.slice(0,startIdx)+"    const ticket = await createTicketFor(userId, { message, category, imageUrl });\n"+s.slice(endIdx+endMarker.length);
const helper=`
/**
 * createTicketFor — saves a SupportTicket and relays it to the CRM.
 * Shared by the "Report an issue" form and the Luna/Fiza chat (Nov 2026).
 */
async function createTicketFor(userId, { message, category = "APP_ISSUE", imageUrl = null, source = "form" }) {
  const cat = CATEGORIES.includes(String(category).toUpperCase()) ? String(category).toUpperCase() : "OTHER";
  const now = new Date();
  const ticket = await SupportTicket.create({
    userId,
    category: cat,
    message,
    imageUrl,
    status: "received",
    dueAt: addWorkingDays(now, 3),
    lastActivityAt: now,
    userUnread: false,
    adminUnread: true,
  });

  let user = null;
  try { user = await User.findByPk(userId); } catch (_) { /* non-fatal */ }
  const plan = await getUserPlan(userId);

  const synced = await sendToCrm("support_issue", {
    ticket_id: ticket.id,
    app_user_id: String(userId),
    message,
    category: cat,
    priority: cat === "MEDICAL" ? "high" : "normal",
    image_url: imageUrl,
    phone: (user && user.phone) || null,
    email: (user && user.email) || null,
    name: fullName(user),
    plan,
    source,
    due_at: ticket.dueAt,
    external_event_id: \`ticket_\${ticket.id}\`,
  });
  if (synced) {
    ticket.crmSynced = true;
    await ticket.save();
  }
  return ticket;
}
exports.createTicketFor = createTicketFor;
`;
s=s.replace("/**\n * reportIssue", helper+"\n/**\n * reportIssue");
fs.writeFileSync(p,s);console.log("ok");
