/**
 * handlers.js — event handlers for app-backend webhooks.
 *
 * Each handler:
 *   1. Finds or matches the lead (by app_user_id, then phone, then email)
 *   2. Updates lead columns relevant to that event
 *   3. Fires automation events (so existing rules engine handles welcome/win-back/etc.)
 *   4. Marks app_events row as processed
 *
 * Handlers MUST be idempotent — webhooks may be delivered more than once.
 */

const { v4: uuidv4 } = require("uuid");
const sequelize = require("../config/database");
const { fireEvent } = require("../services/event.service");
const { writeActivity } = require("../services/activity.service");
const { normalizePhoneDigits } = require("../services/phoneCountry");

/**
 * Find an existing lead matching the app payload, or create one if not found.
 * Match priority:
 *   1. app_user_id (if a previous webhook already linked them)
 *   2. phone (most reliable for FitHer — leads come in via WhatsApp first)
 *   3. email (fallback)
 *
 * If no match, creates a new lead with source='app'.
 */
async function findOrLinkLead({ app_user_id, phone, email, name, language, timezone, mainGoal, has_pcos }) {
  if (!app_user_id) throw new Error("app_user_id is required");

  // 1. By app_user_id
  let [rows] = await sequelize.query(
    `SELECT * FROM leads WHERE app_user_id = :id LIMIT 1`,
    { replacements: { id: String(app_user_id) } }
  );
  if (rows[0]) return { lead: rows[0], created: false, matchedBy: "app_user_id" };

  // 2. By phone — normalized to E.164 digits without '+' ("923001234567"),
  //    the format WhatsApp leads are stored in, so "03001234567" / "+92 300
  //    1234567" from the app match the existing WhatsApp lead. The legacy
  //    space/+-stripped form is still accepted for rows saved before this.
  const normalizedPhone = phone ? normalizePhoneDigits(phone) : null;
  if (normalizedPhone) {
    const legacy = String(phone).replace(/[\s+]/g, "");
    [rows] = await sequelize.query(
      `SELECT * FROM leads
        WHERE phone = :phone
           OR REPLACE(REPLACE(phone, ' ', ''), '+', '') IN (:phone, :legacy)
        ORDER BY (phone = :phone) DESC, id ASC
        LIMIT 1`,
      { replacements: { phone: normalizedPhone, legacy } }
    );
    if (rows[0]) {
      // Link the lead to this app_user_id
      await sequelize.query(
        `UPDATE leads SET app_user_id = :id, app_synced_at = NOW() WHERE id = :leadId`,
        { replacements: { id: String(app_user_id), leadId: rows[0].id } }
      );
      return { lead: rows[0], created: false, matchedBy: "phone" };
    }
  }

  // 3. By email
  if (email) {
    [rows] = await sequelize.query(
      `SELECT * FROM leads WHERE email = :email LIMIT 1`,
      { replacements: { email } }
    );
    if (rows[0]) {
      await sequelize.query(
        `UPDATE leads SET app_user_id = :id, app_synced_at = NOW() WHERE id = :leadId`,
        { replacements: { id: String(app_user_id), leadId: rows[0].id } }
      );
      return { lead: rows[0], created: false, matchedBy: "email" };
    }
  }

  // 4. Create new
  const [insertResult] = await sequelize.query(
    `INSERT INTO leads
       (phone, email, name, app_user_id, language, source, stage, status,
        whatsapp_account_id, app_timezone, main_goal_app, has_pcos,
        last_activity_at, app_synced_at, created_at)
     VALUES
       (:phone, :email, :name, :appUserId, :lang, 'app', 'visitor', 'new',
        1, :tz, :goal, :hasPcos,
        NOW(), NOW(), NOW())`,
    {
      replacements: {
        phone: normalizedPhone || null,
        email: email || null,
        name: name || null,
        appUserId: String(app_user_id),
        lang: language || "en",
        tz: timezone || null,
        goal: mainGoal || null,
        hasPcos: has_pcos ? 1 : 0,
      },
    }
  );

  const newId = insertResult.insertId;
  const [created] = await sequelize.query(
    `SELECT * FROM leads WHERE id = :id`,
    { replacements: { id: newId } }
  );
  return { lead: created[0], created: true, matchedBy: "new" };
}

// ────────────────────────────────────────────────────────────────
// EVENT HANDLERS
// ────────────────────────────────────────────────────────────────

async function handleUserSignup(payload) {
  const { lead, created, matchedBy } = await findOrLinkLead(payload);

  // Update profile fields
  await sequelize.query(
    `UPDATE leads
        SET name = COALESCE(:name, name),
            email = COALESCE(:email, email),
            app_timezone = COALESCE(:tz, app_timezone),
            main_goal_app = COALESCE(:goal, main_goal_app),
            target_weight_kg = COALESCE(:tw, target_weight_kg),
            has_pcos = GREATEST(has_pcos, :pcos),
            app_synced_at = NOW()
      WHERE id = :id`,
    {
      replacements: {
        id: lead.id,
        name: payload.name || (payload.firstName ? `${payload.firstName} ${payload.lastName || ""}`.trim() : null),
        email: payload.email || null,
        tz: payload.timezone || null,
        goal: payload.mainGoal || null,
        tw: payload.target_weight_kg || null,
        pcos: payload.has_pcos ? 1 : 0,
      },
    }
  );

  await writeActivity(lead.id, "form_submitted", "app", { kind: "signup", app_user_id: payload.app_user_id });
  if (created) {
    await fireEvent(lead.id, "lead_created", { source: "app", app_user_id: payload.app_user_id });
  }
  await fireEvent(lead.id, "app_signup", { app_user_id: payload.app_user_id, matchedBy });
  return { leadId: lead.id, created, matchedBy };
}

async function handleUserLogin(payload) {
  const { lead } = await findOrLinkLead(payload);
  await sequelize.query(
    `UPDATE leads SET last_login_at = NOW(), app_synced_at = NOW() WHERE id = :id`,
    { replacements: { id: lead.id } }
  );
  return { leadId: lead.id };
}

async function handleSubscriptionStarted(payload) {
  const { lead } = await findOrLinkLead(payload);

  await sequelize.query(
    `UPDATE leads
        SET subscription_plan_id = :planId,
            subscription_plan_title = :planTitle,
            subscription_status = 'active',
            subscription_started_at = :startedAt,
            subscription_expires_at = :expiresAt,
            subscription_amount = :amount,
            subscription_currency = :currency,
            lifetime_value_pkr = lifetime_value_pkr + :pkrAmount,
            stage = 'user',
            status = 'converted',
            app_synced_at = NOW()
      WHERE id = :id`,
    {
      replacements: {
        id: lead.id,
        planId: payload.plan_id || null,
        planTitle: payload.plan_title || null,
        startedAt: payload.started_at || new Date(),
        expiresAt: payload.expires_at || null,
        amount: payload.amount || 0,
        currency: payload.currency || "PKR",
        pkrAmount: payload.currency === "USD"
          ? Number(payload.amount || 0) * 280  // rough conversion; refine in v2
          : Number(payload.amount || 0),
      },
    }
  );

  await writeActivity(lead.id, "payment_completed", "app", payload);
  await fireEvent(lead.id, "subscription_started", payload);
  await fireEvent(lead.id, "payment_success", payload);

  // Phase 9 — sales attribution
  try {
    const { recordConversion } = require("../services/repAttribution.service");
    const freshLead = await sequelize.query(
      "SELECT id, assigned_to FROM leads WHERE id = ?",
      { replacements: [lead.id], type: sequelize.QueryTypes.SELECT }
    );
    await recordConversion({
      lead: freshLead[0] || { id: lead.id },
      payment: {
        plan_name: payload.plan_title,
        plan_duration_months: payload.plan_duration_months || null,
        amount: payload.amount,
        currency: payload.currency,
        source: "app_webhook",
      },
    });
  } catch (e) {
    console.error("[handleSubscriptionStarted] attribution failed:", e.message);
  }

  return { leadId: lead.id };
}

async function handleSubscriptionRenewed(payload) {
  // Same as started, but doesn't reset stage
  const { lead } = await findOrLinkLead(payload);
  await sequelize.query(
    `UPDATE leads
        SET subscription_expires_at = :expiresAt,
            subscription_status = 'active',
            subscription_amount = :amount,
            lifetime_value_pkr = lifetime_value_pkr + :pkrAmount,
            app_synced_at = NOW()
      WHERE id = :id`,
    {
      replacements: {
        id: lead.id,
        expiresAt: payload.expires_at,
        amount: payload.amount || 0,
        pkrAmount: payload.currency === "USD" ? Number(payload.amount || 0) * 280 : Number(payload.amount || 0),
      },
    }
  );
  await fireEvent(lead.id, "subscription_renewed", payload);
  return { leadId: lead.id };
}

async function handleSubscriptionFrozen(payload) {
  const { lead } = await findOrLinkLead(payload);
  await sequelize.query(
    `UPDATE leads
        SET subscription_status = 'frozen', app_synced_at = NOW()
      WHERE id = :id`,
    { replacements: { id: lead.id } }
  );
  await fireEvent(lead.id, "subscription_frozen", payload);
  return { leadId: lead.id };
}

async function handleSubscriptionUnfrozen(payload) {
  const { lead } = await findOrLinkLead(payload);
  await sequelize.query(
    `UPDATE leads
        SET subscription_status = 'active', app_synced_at = NOW()
      WHERE id = :id`,
    { replacements: { id: lead.id } }
  );
  await fireEvent(lead.id, "subscription_resumed", payload);
  return { leadId: lead.id };
}

async function handleSubscriptionExpired(payload) {
  const { lead } = await findOrLinkLead(payload);
  await sequelize.query(
    `UPDATE leads
        SET subscription_status = 'expired',
            stage = 'churned',
            churn_trigger = 'subscription_expired',
            app_synced_at = NOW()
      WHERE id = :id`,
    { replacements: { id: lead.id } }
  );
  await fireEvent(lead.id, "subscription_expired", payload);
  await fireEvent(lead.id, "churn_detected", { trigger: "subscription_expired" });
  return { leadId: lead.id };
}

async function handlePaymentFailed(payload) {
  const { lead } = await findOrLinkLead(payload);
  await fireEvent(lead.id, "payment_failed", payload);
  return { leadId: lead.id };
}

async function handleClassAttended(payload) {
  const { lead } = await findOrLinkLead(payload);
  await sequelize.query(
    `UPDATE leads
        SET total_workouts_completed = total_workouts_completed + 1,
            app_synced_at = NOW()
      WHERE id = :id`,
    { replacements: { id: lead.id } }
  );
  await writeActivity(lead.id, "session_joined", "app", payload);
  return { leadId: lead.id };
}

async function handleDietDayCompleted(payload) {
  const { lead } = await findOrLinkLead(payload);
  await sequelize.query(
    `UPDATE leads
        SET total_diet_days_completed = total_diet_days_completed + 1,
            app_synced_at = NOW()
      WHERE id = :id`,
    { replacements: { id: lead.id } }
  );
  await writeActivity(lead.id, "workout_completed", "app", payload);
  return { leadId: lead.id };
}

async function handleProfileUpdated(payload) {
  const { lead } = await findOrLinkLead(payload);
  const fields = [];
  const replacements = { id: lead.id };

  const allowed = {
    name: "name",
    email: "email",
    phone: "phone",
    timezone: "app_timezone",
    mainGoal: "main_goal_app",
    target_weight_kg: "target_weight_kg",
    language: "language",
  };
  for (const [k, col] of Object.entries(allowed)) {
    if (payload[k] != null) {
      fields.push(`${col} = :${k}`);
      // Store phones in the same canonical form as WhatsApp leads.
      replacements[k] = k === "phone" ? (normalizePhoneDigits(payload[k]) || payload[k]) : payload[k];
    }
  }
  if (fields.length === 0) return { leadId: lead.id, noChange: true };

  fields.push(`app_synced_at = NOW()`);
  await sequelize.query(
    `UPDATE leads SET ${fields.join(", ")} WHERE id = :id`,
    { replacements }
  );
  return { leadId: lead.id };
}

// ────────────────────────────────────────────────────────────────
// DISPATCHER
// ────────────────────────────────────────────────────────────────

/**
 * handleSupportIssue — a user reported an issue / sent a message from the app.
 * Turns it into an inbound conversation message the admin/rep sees in the CRM,
 * assigned to a rep, with a push notification. This is the "app → admin" channel.
 *
 * payload: { app_user_id, phone?, email?, name?, message, category?, priority? }
 */
async function handleSupportIssue(payload) {
  const { app_user_id, phone, email, name, message, category, priority, image_url, plan } = payload || {};
  // Either a written issue OR an image (or both) must be present.
  if ((!message || !String(message).trim()) && !image_url) {
    throw new Error("message or image_url is required for support_issue");
  }

  // 1. Resolve (or create) the person record from the app user.
  const { lead } = await findOrLinkLead({ app_user_id, phone, email, name });

  // 2. Technical / app-service issues are ADMIN-handled — NOT sales reps.
  //    We deliberately do NOT round-robin this to a sales rep; it's stored
  //    unassigned (rep_id NULL) and flagged escalated so it lands in the admin
  //    queue. Sales-rep dashboards filter by assigned_to, so reps won't see it.
  const text = message ? String(message).trim() : "";
  // Prepend the user's current package/plan so the admin sees context inline.
  const planLine = plan
    ? `🧾 Plan: ${plan.title || "—"}${plan.status ? ` (${plan.status})` : ""}${plan.expires ? `, expires ${plan.expires}` : ""}`
    : null;
  const catText = category ? `[${category}] ${text}`.trim() : text;
  const body = [planLine, catText].filter(Boolean).join("\n");

  // 3. Store it as an inbound 'app' message (image if a screenshot was attached,
  //    with the text as the caption; otherwise a plain text message).
  const waAccount = lead.whatsapp_account_id || 1; // messages.whatsapp_account_id is NOT NULL
  if (image_url) {
    await sequelize.query(
      "INSERT INTO messages (lead_id, whatsapp_account_id, `from`, message, direction, message_type, channel, media_url, status, is_read, created_at, updated_at) " +
        "VALUES (:lead, :acc, 'user', :body, 'IN', 'image', 'app', :media, 'received', 0, NOW(), NOW())",
      { replacements: { lead: lead.id, acc: waAccount, body: body || null, media: image_url } }
    );
  } else {
    await sequelize.query(
      "INSERT INTO messages (lead_id, whatsapp_account_id, `from`, message, direction, message_type, channel, status, is_read, created_at, updated_at) " +
        "VALUES (:lead, :acc, 'user', :body, 'IN', 'text', 'app', 'received', 0, NOW(), NOW())",
      { replacements: { lead: lead.id, acc: waAccount, body } }
    );
  }

  // 4. Record the issue itself for the dedicated "App Issues" admin section.
  await sequelize.query(
    `INSERT INTO app_issues
        (lead_id, app_user_id, category, priority, message, image_url, plan_title, status, created_at)
     VALUES
        (:lead, :appUser, :category, :priority, :message, :image, :planTitle, 'open', NOW())`,
    {
      replacements: {
        lead: lead.id,
        appUser: app_user_id ? String(app_user_id) : null,
        category: category || "APP_ISSUE",
        priority: priority === "high" || category === "MEDICAL" ? "high" : "normal",
        message: text || null,
        image: image_url || null,
        planTitle: plan && plan.title ? plan.title : null,
      },
    }
  ).catch((e) => console.error("[support_issue] app_issues insert failed:", e.message));

  // 5. Flag it for the admin queue + bump conversation counters.
  await sequelize.query(
    `UPDATE leads
        SET unread_count     = unread_count + 1,
            last_message_at  = NOW(),
            last_activity_at = NOW(),
            is_escalated     = 1
      WHERE id = :id`,
    { replacements: { id: lead.id } }
  );

  // 5. Timeline + event.
  await writeActivity(lead.id, "message_received", "app", {
    kind: "support_issue",
    category: category || null,
    priority: priority || "normal",
    has_image: !!image_url,
  });
  await fireEvent(lead.id, "support_issue", {
    app_user_id: app_user_id || null,
    category: category || null,
    priority: priority || "normal",
  });

  // 6. Notify ADMINS (push). Technical issues go to admins, not reps.
  try {
    const { sendPushToSalesRep } = require("../services/notificationService");
    const [admins] = await sequelize.query(
      `SELECT id FROM sales_reps WHERE role = 'admin' AND status = 'active'`
    );
    const urgent = priority === "high" || category === "MEDICAL";
    const preview = text ? text.slice(0, 80) : "📷 Screenshot attached";
    await Promise.all(
      (admins || []).map((a) =>
        sendPushToSalesRep(
          a.id,
          urgent ? "🚨 Urgent app issue" : "New app issue",
          `Lead #${lead.id}: ${preview}`,
          { lead_id: lead.id, channel: "app", kind: "support_issue", category: category || "" }
        ).catch(() => {})
      )
    );
  } catch (e) {
    console.error("[support_issue] admin notify failed:", e.message);
  }

  return { leadId: lead.id, routedTo: "admin" };
}

const HANDLERS = {
  user_signup:           handleUserSignup,
  support_issue:         handleSupportIssue,
  app_message:           handleSupportIssue, // alias
  user_login:            handleUserLogin,
  subscription_started:  handleSubscriptionStarted,
  subscription_renewed:  handleSubscriptionRenewed,
  subscription_frozen:   handleSubscriptionFrozen,
  subscription_unfrozen: handleSubscriptionUnfrozen,
  subscription_expired:  handleSubscriptionExpired,
  payment_success:       handleSubscriptionStarted, // alias — payments often == subscription
  payment_failed:        handlePaymentFailed,
  class_attended:        handleClassAttended,
  diet_day_completed:    handleDietDayCompleted,
  profile_updated:       handleProfileUpdated,
};

/**
 * dispatchEvent — top-level entry point for every app → CRM event.
 *
 * Reliability rules (so the app backend can safely retry):
 *   • Same external_event_id already processed/skipped → "duplicate", no work.
 *   • Same id that previously FAILED → reprocessed on the same audit row.
 *   • Same id still being processed right now (< 2 min) → "in_progress";
 *     the route answers 409 and the sender retries later.
 *   • Two identical requests racing → the unique key catches the second one.
 *   • State events (subscription / payment) carry payload.occurred_at. If a
 *     NEWER state event for the same app user was already applied, an older
 *     one arriving late is marked skipped ("stale") instead of overwriting it.
 *
 * Throws when a handler fails, so the route can answer 500 and the sender
 * retries.
 *
 * @param {string} eventType
 * @param {object} payload — must include app_user_id
 * @param {string} [externalEventId] — idempotency key
 * @returns {Promise<{ eventId, status, leadId?, created?, matchedBy? }>}
 *          status: processed | duplicate | in_progress | skipped | stale
 */
const STATE_EVENTS = [
  "subscription_started", "subscription_renewed", "subscription_frozen",
  "subscription_unfrozen", "subscription_expired", "payment_success", "payment_failed",
];
const IN_PROGRESS_GRACE_SEC = 120;

function parseOccurredAt(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

async function markRow(eventId, status, { leadId = null, msg = null } = {}) {
  await sequelize.query(
    `UPDATE app_events
        SET status = :status, lead_id = COALESCE(:leadId, lead_id),
            error_message = :msg, processed_at = NOW()
      WHERE event_id = :id`,
    { replacements: { id: eventId, status, leadId, msg: msg ? String(msg).slice(0, 1000) : null } }
  );
}

async function dispatchEvent(eventType, payload, externalEventId) {
  payload = payload || {};
  const occurredAt = parseOccurredAt(payload.occurred_at);
  const appUserId = String(payload.app_user_id || "unknown");
  let eventId = null;

  // 1. Idempotency
  if (externalEventId) {
    const [existing] = await sequelize.query(
      `SELECT event_id, lead_id, status,
              TIMESTAMPDIFF(SECOND, received_at, NOW()) AS age_sec
         FROM app_events WHERE external_event_id = :ext LIMIT 1`,
      { replacements: { ext: externalEventId } }
    );
    const row = existing[0];
    if (row) {
      if (row.status === "processed" || row.status === "skipped") {
        console.log(`⏭  [appEvent] duplicate ${externalEventId} (${row.status}) — skipping`);
        return { eventId: row.event_id, leadId: row.lead_id, status: "duplicate" };
      }
      if (row.status === "received" && Number(row.age_sec) < IN_PROGRESS_GRACE_SEC) {
        return { eventId: row.event_id, leadId: row.lead_id, status: "in_progress" };
      }
      // failed, or stuck in "received" → retry on the same audit row
      eventId = row.event_id;
      await sequelize.query(
        `UPDATE app_events
            SET status = 'received', payload = :payload, occurred_at = :occurredAt,
                error_message = NULL, received_at = NOW(), processed_at = NULL
          WHERE event_id = :id`,
        { replacements: { id: eventId, payload: JSON.stringify(payload), occurredAt } }
      );
      console.log(`🔁 [appEvent] retrying ${externalEventId} (was ${row.status})`);
    }
  }

  // 2. Audit-log the event up front (new events only)
  if (!eventId) {
    eventId = uuidv4();
    try {
      await sequelize.query(
        `INSERT INTO app_events (event_id, external_event_id, app_user_id, event_type, payload, occurred_at, status)
         VALUES (:eventId, :externalId, :appUserId, :eventType, :payload, :occurredAt, 'received')`,
        {
          replacements: {
            eventId,
            externalId: externalEventId || null,
            appUserId,
            eventType,
            payload: JSON.stringify(payload),
            occurredAt,
          },
        }
      );
    } catch (err) {
      const dup = err?.original?.code === "ER_DUP_ENTRY" || err?.parent?.code === "ER_DUP_ENTRY";
      if (dup && externalEventId) {
        // Another request with the same id won the race.
        return { eventId: null, status: "in_progress" };
      }
      throw err;
    }
  }

  // 3. Unknown type → skipped (never retried; the sender should stop)
  const handler = HANDLERS[eventType];
  if (!handler) {
    await markRow(eventId, "skipped", { msg: `No handler for event type '${eventType}'` });
    return { eventId, status: "skipped", error: `Unknown event type: ${eventType}` };
  }

  // 4. Out-of-order guard for state events
  if (occurredAt && STATE_EVENTS.includes(eventType) && appUserId !== "unknown") {
    const [newer] = await sequelize.query(
      `SELECT event_id, event_type, occurred_at FROM app_events
        WHERE app_user_id = :appUserId
          AND event_type IN (:types)
          AND status = 'processed'
          AND occurred_at > :occurredAt
          AND event_id <> :eventId
        ORDER BY occurred_at DESC LIMIT 1`,
      { replacements: { appUserId, types: STATE_EVENTS, occurredAt, eventId } }
    );
    if (newer[0]) {
      const msg = `stale: newer ${newer[0].event_type} already applied`;
      await markRow(eventId, "skipped", { msg });
      console.log(`⏭  [appEvent] ${eventType} for user ${appUserId} is ${msg}`);
      return { eventId, status: "stale" };
    }
  }

  // 5. Process
  try {
    const result = await handler(payload);
    await markRow(eventId, "processed", { leadId: result?.leadId ?? null });
    return { eventId, status: "processed", ...result };
  } catch (err) {
    await markRow(eventId, "failed", { msg: err.message || "unknown" });
    console.error(`❌ [appEvent] ${eventType} failed:`, err.message);
    throw err;
  }
}

module.exports = { dispatchEvent, HANDLERS };
