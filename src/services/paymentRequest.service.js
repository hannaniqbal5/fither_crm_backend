/**
 * paymentRequest.service.js — WhatsApp payments (Nov 2026).
 *
 *   1. Rep taps "Request payment" (plan + price) → create(): the app backend
 *      makes its payment record (signed /internal/crm/magic-links), we keep a
 *      payment_requests row, and she gets ONE WhatsApp message with the amount
 *      and our accounts. No link for her to open.
 *   2. She sends a photo while a request is open → checkSlip(): the photo goes
 *      to the app backend's slip checker (/internal/crm/payment-slips), the
 *      same one the app uses (our account, unused reference, date, amount).
 *   3. Result → the rep sees it live in the chat; she gets a short reply:
 *        approved, has the app   → "plan started"
 *        approved, no app yet    → "download Fit Her, sign up with this number"
 *        needs a person          → "received, our team is checking"
 *      Duplicate / expired → the rep only (she gets nothing automatic).
 */
const fs = require("fs");
const path = require("path");
const sequelize = require("../config/database");
const { partnerCall } = require("./partnerSigned");
const { writeActivity } = require("./activity.service");

const OPEN = ["open", "review", "rejected"];       // a new photo may still be her slip
const IMAGE_TYPES = new Set(["image", "document"]);

let tableOk = null;
async function ready() {
  if (tableOk) return true;
  try {
    await sequelize.query("SELECT 1 FROM payment_requests LIMIT 1");
    tableOk = true;
  } catch (e) {
    if (!/payment_requests/.test(e.message)) throw e;
    tableOk = false;
  }
  return tableOk;
}

const money = (n, cur = "PKR") => `${cur === "PKR" ? "Rs" : cur} ${Number(n).toLocaleString("en-PK")}`;
const localPhone = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.startsWith("92") ? `0${d.slice(2)}` : d; };

async function accountsFor(lead) {
  const { PaymentAccount } = require("../../models");
  const { detectCountry } = require("./phoneCountry");
  const cc = detectCountry(lead.phone || (lead.whatsapp_jid || "").split("@")[0]);
  let list = cc ? await PaymentAccount.findAll({ where: { country_code: cc, is_active: true }, order: [["display_order", "ASC"], ["id", "ASC"]] }) : [];
  if (!list.length) list = await PaymentAccount.findAll({ where: { is_active: true, country_code: "PK" }, order: [["display_order", "ASC"], ["id", "ASC"]] });
  return list;
}

function requestText(lead, r, accounts) {
  const name = lead.name ? ` ${String(lead.name).split(" ")[0]}` : "";
  const lines = accounts.map((a) => {
    const bits = [`• *${a.bank_name}* — ${a.account_holder}`, `  ${a.account_number}`];
    if (a.iban) bits.push(`  IBAN: ${a.iban}`);
    if (a.instructions) bits.push(`  ${a.instructions}`);
    return bits.join("\n");
  });
  return [
    `Assalam o Alaikum${name},`,
    "",
    `Aap ka FitHer *${r.plan_title || "plan"}*${r.duration_label ? ` (${r.duration_label})` : ""}: *${money(r.amount, r.currency)}*`,
    "",
    lines.length ? "In mein se kisi account mein payment karein:" : "Payment ke liye account details aap ki rep bhej de gi.",
    ...lines,
    "",
    "Payment ke baad slip ki photo *yahin* bhej dein. Shukriya! 🌸",
  ].join("\n");
}

async function sendToHer(lead, text, io) {
  const { send } = require("../channels/channelRouter");
  const out = await send(lead, text, "whatsapp");
  if (out && out.success) {
    await require("./outboundMessage").recordOutbound(lead, {
      text, channel: out.channel || "whatsapp", externalId: out.messageId || null, from: "bot", io,
    }).catch((e) => console.warn("[payment] record outbound:", e.message));
  }
  return out;
}

function notifyRep(io, lead, request, extra = {}) {
  if (!io) return;
  const payload = { lead_id: lead.id, request, ...extra };
  if (lead.assigned_to) io.to(`rep_${lead.assigned_to}`).emit("paymentRequest", payload);
  io.to("admins").emit("paymentRequest", payload);
}

async function get(id) {
  const [[r]] = await sequelize.query("SELECT * FROM payment_requests WHERE id = :id", { replacements: { id } });
  return r || null;
}

async function listFor(leadId) {
  if (!(await ready())) return [];
  await sequelize.query(
    "UPDATE payment_requests SET status = 'expired' WHERE lead_id = :id AND status IN ('open','rejected') AND expires_at < NOW()",
    { replacements: { id: leadId } }
  );
  const [rows] = await sequelize.query("SELECT * FROM payment_requests WHERE lead_id = :id ORDER BY id DESC LIMIT 20", { replacements: { id: leadId } });
  return rows;
}

async function openFor(leadId) {
  if (!(await ready())) return null;
  const [[r]] = await sequelize.query(
    `SELECT * FROM payment_requests WHERE lead_id = :id AND status IN (:open) AND expires_at > NOW() ORDER BY id DESC LIMIT 1`,
    { replacements: { id: leadId, open: OPEN } }
  );
  return r || null;
}

/**
 * Rep's "Request payment". body: PlanId, PriceDurationId, listPrice, paidAmount,
 * discountReason?, plan_title, duration_label, currency?, validDays?, send? (default true)
 */
async function create(lead, rep, body, io) {
  if (!(await ready())) throw Object.assign(new Error("Run migration 044_payment_requests.sql first"), { status: 503 });
  const days = [3, 5, 7].includes(Number(body.validDays)) ? Number(body.validDays) : 3;
  // Optional signup email: the plan starts when she signs up with this
  // phone OR this email. Falls back to the email already on her lead.
  const rawEmail = String(body.email || lead.email || "").trim().toLowerCase();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : null;
  if (email && !lead.email) {
    await sequelize.query("UPDATE leads SET email = :e WHERE id = :id AND (email IS NULL OR email = '')",
      { replacements: { e: email, id: lead.id } }).catch(() => {});
  }
  const link = await partnerCall("POST", "/internal/crm/magic-links", {
    PlanId: body.PlanId, PriceDurationId: body.PriceDurationId,
    listPrice: body.listPrice, paidAmount: body.paidAmount, discountReason: body.discountReason || null,
    phone: lead.phone || null, email, crmLeadId: lead.id, validDays: days,
    partner_user_id: rep?.partner_user_id || undefined, agent_name: rep?.name || undefined,
    notes: `WhatsApp payment request · ${body.plan_title || ""} ${body.duration_label || ""}`.trim(),
  });
  // One open request per woman: a new one replaces the old.
  await sequelize.query(
    "UPDATE payment_requests SET status = 'cancelled' WHERE lead_id = :id AND status IN ('open','review','rejected')",
    { replacements: { id: lead.id } }
  );
  const [ins] = await sequelize.query(
    `INSERT INTO payment_requests (lead_id, rep_id, token, plan_title, duration_label, amount, currency, expires_at)
     VALUES (:lead, :rep, :token, :plan, :dur, :amount, :cur, :exp)`,
    { replacements: {
      lead: lead.id, rep: rep?.id || null, token: link.token,
      plan: body.plan_title || null, dur: body.duration_label || null,
      amount: Number(link.paidAmount || body.paidAmount), cur: body.currency || "PKR",
      exp: new Date(link.expiresAt || Date.now() + days * 864e5),
    } }
  );
  const request = await get(require("../utils/insertId").insertIdOf(ins));
  let sent = null;
  if (body.send !== false) {
    const text = requestText(lead, request, await accountsFor(lead));
    sent = await sendToHer(lead, text, io);
  }
  try {
    await sequelize.query(
      "UPDATE leads SET interaction_status = 'payment_link_sent', last_intent_detected_at = NOW() WHERE id = :id",
      { replacements: { id: lead.id } }
    );
  } catch (_) { /* older DB without the layer columns */ }
  await writeActivity(lead.id, "payment_requested", "crm", {
    request_id: request.id, plan: request.plan_title, amount: request.amount, rep_id: rep?.id || null, sent: !!(sent && sent.success),
  }).catch(() => {});
  notifyRep(io, lead, request);
  return { request, sent: sent ? { success: !!sent.success, error: sent.error || null } : null };
}

function fileFor(mediaUrl) {
  const { resolveMediaPath } = require("../ai/voiceTranscription.service");
  const p = resolveMediaPath(mediaUrl);
  return p && fs.existsSync(p) ? p : null;
}
const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic" };

/**
 * Check one photo as her slip. Called for every photo she sends while a
 * request is open (auto), or when the rep taps "Check as payment slip".
 */
async function checkSlip(lead, message, { io = null, requestId = null, manual = false } = {}) {
  if (!(await ready())) return null;
  const request = requestId ? await get(requestId) : await openFor(lead.id);
  if (!request || Number(request.lead_id) !== Number(lead.id)) return null;
  if (!manual && !IMAGE_TYPES.has(message.message_type)) return null;
  if (message.message_type === "document" && !/^image\//.test(String(message.media_mime || ""))) {
    if (!manual) return null; // a PDF etc.: the rep decides
  }
  const file = fileFor(message.media_url);
  if (!file) {
    notifyRep(io, lead, request, { error: "The photo could not be read from storage" });
    return null;
  }
  const mime = message.media_mime && /^image\//.test(message.media_mime)
    ? message.media_mime
    : MIME_BY_EXT[path.extname(file).toLowerCase()] || "image/jpeg";

  await sequelize.query("UPDATE payment_requests SET status = 'checking', slip_message_id = :m WHERE id = :id", { replacements: { m: message.id, id: request.id } });
  let res;
  try {
    res = await partnerCall("POST", "/internal/crm/payment-slips", {
      token: request.token,
      image_base64: fs.readFileSync(file).toString("base64"),
      mime,
      app_user_id: lead.app_user_id || undefined,
    });
  } catch (e) {
    // partnerCall throws on status "0" (duplicate, expired …) — that's a result, not a crash.
    const reason = e.message || "Slip check failed";
    const expired = /expired/i.test(reason);
    await sequelize.query("UPDATE payment_requests SET status = :s, result_reason = :r WHERE id = :id",
      { replacements: { s: expired ? "expired" : "rejected", r: reason.slice(0, 250), id: request.id } });
    await writeActivity(lead.id, "payment_slip_checked", "whatsapp", { request_id: request.id, ok: false, reason }).catch(() => {});
    const updated = await get(request.id);
    notifyRep(io, lead, updated, { result: "failed", reason });
    return updated;
  }

  const status = res.verificationStatus === "verified" ? "approved"
    : res.verificationStatus === "verified_waiting_signup" ? "waiting_signup" : "review";
  await sequelize.query(
    "UPDATE payment_requests SET status = :s, result_reason = :r, plan_image_id = :pi WHERE id = :id",
    { replacements: { s: status, r: String(res.reason || "").slice(0, 250) || null, pi: res.planImageId || null, id: request.id } }
  );
  const appUrl = process.env.APP_DOWNLOAD_URL || "https://thefither.com/app";
  const reply = status === "approved"
    ? "Payment mil gayi ✅ Shukriya!\n\nAap ka plan Fit Her app mein start ho gaya hai. App khol kar dekh lein 🌸"
    : status === "waiting_signup"
      ? `Payment mil gayi ✅ Shukriya!\n\nAb Fit Her app download karein aur *isi number (${localPhone(lead.phone)})* se sign up karein — aap ka plan khud start ho jaye ga:\n${appUrl}`
      : "Slip mil gayi, shukriya! 🌸 Hamari team check kar ke thori der mein confirm kare gi.";
  await sendToHer(lead, reply, io).catch((e) => console.warn("[payment] reply:", e.message));
  await writeActivity(lead.id, "payment_slip_checked", "whatsapp", {
    request_id: request.id, ok: status !== "review", status, reason: res.reason || null, plan_image_id: res.planImageId || null,
  }).catch(() => {});
  const updated = await get(request.id);
  notifyRep(io, lead, updated, { result: status, reason: res.reason || null, ocr: res.ocrSummary || null });
  return updated;
}

/** Message handler hook: a photo she sent. Never throws, never blocks. */
function onInbound(lead, message, io) {
  if (!lead || !message || message.direction !== "IN" || !message.media_url) return;
  if (!IMAGE_TYPES.has(message.message_type)) return;
  setImmediate(async () => {
    try {
      const open = await openFor(lead.id);
      if (open && open.status !== "checking") await checkSlip(lead, message, { io, requestId: open.id });
    } catch (e) {
      console.error("[payment] slip check:", e.message);
    }
  });
}

async function cancel(lead, id) {
  await sequelize.query(
    "UPDATE payment_requests SET status = 'cancelled' WHERE id = :id AND lead_id = :lead AND status IN ('open','review','rejected')",
    { replacements: { id, lead: lead.id } }
  );
  return get(id);
}

module.exports = { create, checkSlip, onInbound, listFor, openFor, cancel, requestText, ready };
