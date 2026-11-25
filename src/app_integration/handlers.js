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
const { sqlUtc } = require("../utils/sqlTime");

/**
 * Find an existing lead matching the app payload, or create one if not found.
 * Match priority:
 *   1. app_user_id (if a previous webhook already linked them)
 *   2. phone (most reliable for FitHer — leads come in via WhatsApp first)
 *   3. email (fallback)
 *
 * If no match, creates a new lead with source='app'.
 */
/**
 * linkByCrmLeadId — the app says exactly which CRM lead she is (she paid
 * through a rep's payment link or started from a rep's trial link).
 * Attaches her app_user_id to THAT lead. If an app signup already made a
 * separate lead for her, that duplicate is merged into the real one: its
 * app data is copied over, its open tasks are closed, and it is marked
 * merged (kept for history, ignored from then on).
 * Returns the lead, or null when the id can't be used (unknown lead, or the
 * lead already belongs to a different app user — never overwritten).
 */
async function linkByCrmLeadId(crmLeadId, appUserId) {
  const id = parseInt(crmLeadId, 10);
  if (!id) return null;
  let [rows] = await sequelize.query(
    "SELECT * FROM leads WHERE id = :id AND merged_into_lead_id IS NULL LIMIT 1",
    { replacements: { id } }
  );
  const real = rows[0];
  if (!real) return null;
  if (real.app_user_id && String(real.app_user_id) !== appUserId) {
    console.warn(`[identity] lead ${id} already belongs to app user ${real.app_user_id}; ${appUserId} not linked to it`);
    return null;
  }
  if (String(real.app_user_id || "") === appUserId) return real;

  // A duplicate made earlier from her app signup?
  [rows] = await sequelize.query(
    "SELECT * FROM leads WHERE app_user_id = :a AND id <> :id AND merged_into_lead_id IS NULL ORDER BY id ASC LIMIT 1",
    { replacements: { a: appUserId, id } }
  );
  const dup = rows[0];
  if (dup) {
    await sequelize.query(
      `UPDATE leads r JOIN leads d ON d.id = :dup
          SET r.email = COALESCE(r.email, d.email),
              r.name = COALESCE(r.name, d.name),
              r.app_timezone = COALESCE(r.app_timezone, d.app_timezone),
              r.main_goal_app = COALESCE(r.main_goal_app, d.main_goal_app),
              r.has_pcos = GREATEST(r.has_pcos, d.has_pcos),
              r.app_signed_up_at = COALESCE(r.app_signed_up_at, d.app_signed_up_at),
              r.app_onboarding_step = GREATEST(COALESCE(r.app_onboarding_step, 0), COALESCE(d.app_onboarding_step, 0)),
              r.app_onboarded_at = COALESCE(r.app_onboarded_at, d.app_onboarded_at),
              r.subscription_status = IF(r.subscription_status = 'none', d.subscription_status, r.subscription_status),
              r.subscription_plan_title = COALESCE(r.subscription_plan_title, d.subscription_plan_title),
              r.subscription_started_at = COALESCE(r.subscription_started_at, d.subscription_started_at),
              r.subscription_expires_at = COALESCE(r.subscription_expires_at, d.subscription_expires_at),
              r.app_phone = COALESCE(r.app_phone, d.app_phone, IF(d.phone <> r.phone, d.phone, NULL))
        WHERE r.id = :real`,
      { replacements: { dup: dup.id, real: id } }
    ).catch(async (e) => {
      // app_phone needs migration 036; merge the rest without it.
      if (!/app_phone/.test(e.message)) throw e;
      await sequelize.query(
        `UPDATE leads r JOIN leads d ON d.id = :dup
            SET r.email = COALESCE(r.email, d.email), r.name = COALESCE(r.name, d.name),
                r.subscription_status = IF(r.subscription_status = 'none', d.subscription_status, r.subscription_status)
          WHERE r.id = :real`,
        { replacements: { dup: dup.id, real: id } }
      );
    });
    // Her history follows her: app chat / tickets, timeline, app events,
    // rep sale credit. (Nov 2026 — before, they stayed on the hidden duplicate.)
    for (const t of ["messages", "activities", "app_issues", "app_events", "rep_conversions"]) {
      try {
        await sequelize.query(`UPDATE ${t} SET lead_id = :real WHERE lead_id = :dup`, { replacements: { dup: dup.id, real: id } });
      } catch (e) { console.warn(`[identity] moving ${t} from lead ${dup.id}: ${e.message}`); }
    }
    await sequelize.query(
      "UPDATE leads SET app_user_id = NULL, merged_into_lead_id = :real WHERE id = :dup",
      { replacements: { dup: dup.id, real: id } }
    );
    try {
      await sequelize.query(
        "UPDATE rep_tasks SET status = 'cancelled', closed_at = NOW(), close_reason = 'merged_duplicate' WHERE lead_id = :dup AND status = 'open'",
        { replacements: { dup: dup.id } }
      );
    } catch (_) { /* rep_tasks not there on an old DB */ }
    console.log(`🔗 [identity] duplicate lead ${dup.id} merged into lead ${id} (app user ${appUserId})`);
  }
  await sequelize.query(
    "UPDATE leads SET app_user_id = :a, app_synced_at = NOW() WHERE id = :id",
    { replacements: { a: appUserId, id } }
  );
  await writeActivity(id, "identity_linked", "app", { app_user_id: appUserId, merged_duplicate: dup ? dup.id : null });
  [rows] = await sequelize.query("SELECT * FROM leads WHERE id = :id", { replacements: { id } });
  return rows[0];
}

/**
 * Who her typed phone / email point to (read only). Used by findOrLinkLead and
 * by the one-time import's dry run. `sure` = exactly one woman, no conflict.
 */
async function matchByContact({ phone, email }) {
  let rows;
  // No link. Her typed phone and email still tell us who she is when they
  //    point to exactly ONE woman we know and that woman has no app account
  //    yet: link her automatically (Nov 2026 — was always a suggestion).
  //    Anything unclear stays a suggestion for a rep ("Same person" / "Not her"):
  //      - the phone and the email point to two different leads
  //      - more than one lead has that phone, or that email
  //    Phone is matched on the last 10 digits, so 0300… = +92300… = 92300….
  //    IDENTITY_AUTOLINK=off turns automatic linking off (suggestions only).
  const normalizedPhone = phone ? normalizePhoneDigits(phone) : null;
  const tail = normalizedPhone ? normalizedPhone.replace(/\D/g, "").slice(-10) : null;
  const clues = [];
  let phoneLeads = [];
  let emailLeads = [];
  if (tail && tail.length === 10) {
    [rows] = await sequelize.query(
      `SELECT id, phone, whatsapp_account_id FROM leads
        WHERE RIGHT(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''), 10) = :tail
          AND merged_into_lead_id IS NULL
          AND app_user_id IS NULL
        ORDER BY (assigned_to IS NOT NULL) DESC, last_message_at DESC, id ASC
        LIMIT 3`,
      { replacements: { tail } }
    );
    phoneLeads = rows;
    for (const r of rows) clues.push({ lead: r, reason: "phone", detail: `same phone ${normalizedPhone}` });
  }
  if (email) {
    [rows] = await sequelize.query(
      `SELECT id, phone, whatsapp_account_id FROM leads
        WHERE email = :email AND merged_into_lead_id IS NULL AND app_user_id IS NULL LIMIT 3`,
      { replacements: { email: String(email).trim().toLowerCase() } }
    );
    emailLeads = rows;
    for (const r of rows) if (!clues.some((c) => c.lead.id === r.id)) clues.push({ lead: r, reason: "email", detail: `same email ${email}` });
  }

  const autoOn = String(process.env.IDENTITY_AUTOLINK || "on").toLowerCase() !== "off";
  const sure = (() => {
    const ids = new Set(clues.map((c) => c.lead.id));
    if (ids.size !== 1) return null;                     // nobody, or two different women
    if (phoneLeads.length > 1 || emailLeads.length > 1) return null;
    return { id: [...ids][0], by: phoneLeads.length && emailLeads.length ? "phone_and_email" : phoneLeads.length ? "phone" : "email" };
  })();
  return { normalizedPhone, clues, sure, autoOn };
}

async function findOrLinkLead({ app_user_id, crm_lead_id, crm_ref, phone, email, name, language, timezone, mainGoal, has_pcos }) {
  if (!app_user_id) throw new Error("app_user_id is required");

  // 0. PROOF of who she is — the rep's link carried her lead id:
  //    a signed signup ref (services/signupRef.js) or a payment / trial link.
  const refLeadId = crm_ref ? require("../services/signupRef").check(crm_ref) : null;
  if (crm_ref && !refLeadId) console.warn(`[identity] app user ${app_user_id}: signup ref not valid (expired or forged) — ignored`);
  for (const leadId of [refLeadId, crm_lead_id].filter(Boolean)) {
    const linked = await linkByCrmLeadId(leadId, String(app_user_id));
    if (linked) return { lead: linked, created: false, matchedBy: leadId === refLeadId ? "signup_ref" : "crm_lead_id" };
  }

  // 1. Her app account is already linked.
  let [rows] = await sequelize.query(
    `SELECT * FROM leads WHERE app_user_id = :id AND merged_into_lead_id IS NULL LIMIT 1`,
    { replacements: { id: String(app_user_id) } }
  );
  if (rows[0]) return { lead: rows[0], created: false, matchedBy: "app_user_id" };

  // 2. No link: her typed phone / email (matchByContact, below the rules).
  const { normalizedPhone, clues, sure, autoOn } = await matchByContact({ phone, email });
  if (sure && autoOn) {
    const linked = await linkByCrmLeadId(sure.id, String(app_user_id));
    if (linked) {
      await writeActivity(sure.id, "identity_auto_linked", "app", { app_user_id: String(app_user_id), matched_by: sure.by }).catch(() => {});
      console.log(`🔗 [identity] app user ${app_user_id} → existing lead ${sure.id} (same ${sure.by.replace(/_/g, " ")})`);
      return { lead: linked, created: false, matchedBy: `auto_${sure.by}` };
    }
  }

  // 3. Create her app lead. If another lead already has this number on the
  //    same WhatsApp line, the number stays only in app_phone (leads has
  //    UNIQUE(phone, whatsapp_account_id)) — the suggestion links them later.

  // An app signup gets a rep now, the same as a woman who messages WhatsApp.
  // Fiza still works the lead either way: she answers in the app chat and
  // drafts on WhatsApp, and the rep sees the whole conversation. A rep owning
  // her and Fiza handling her are not alternatives — they run together, which
  // is exactly how the WhatsApp door already behaves.
  //
  // owner_type (migration 031) records which of them is responsible right now,
  // so set it alongside: 'rep' when we have one, 'app' when no rep is active,
  // so "every woman always has exactly one owner" stays true and readable.
  // owner.service.js later moves her to 'fiza' if it has to ask her for a phone
  // number, and back to 'rep' on a handoff.
  //
  // Which rep: the admin's rule (Team → "New leads go to"), across all our
  // WhatsApp numbers — she hasn't written on one yet. She is put on her rep's
  // number, so the rep sees her and messages her from it. (Was: always the
  // rotation of number 1.)
  let appOwner = null;
  let appAccount = Number(process.env.META_DEFAULT_WA_ACCOUNT_ID) || 1; // same default as frontDesk
  try {
    // Every woman gets a rep; Fiza works with the rep, she is never the owner.
    const { getNextRepRoundRobin } = require("../services/assignment.service");
    const nextRep = await getNextRepRoundRobin(null);
    appOwner = nextRep ? nextRep.id : null;
    if (nextRep && nextRep.whatsapp_account_id) appAccount = Number(nextRep.whatsapp_account_id);
    if (!appOwner) console.warn(`[identity] no rep in the rotation — app user ${app_user_id} created without a rep (run script/assignUnowned.js after adding one)`);
  } catch (e) {
    console.error("[identity] rep assignment failed, creating unassigned:", e.message);
  }
  // leads has UNIQUE(phone, whatsapp_account_id). ANY lead may hold this
  // number on that line — including one already linked to another app account
  // (a sister or mother sharing the phone), which the clues above leave out.
  // Then her number goes only in app_phone instead of failing the insert.
  let phoneTaken = false;
  if (normalizedPhone) {
    const [[taken]] = await sequelize.query(
      "SELECT id FROM leads WHERE phone = :p AND whatsapp_account_id = :acc LIMIT 1",
      { replacements: { p: normalizedPhone, acc: appAccount } }
    );
    phoneTaken = !!taken;
  }

  const insertSql = (withAppPhone) => `INSERT INTO leads
       (phone, ${withAppPhone ? "app_phone, " : ""}email, name, app_user_id, language, source, stage, status,
        whatsapp_account_id, assigned_to, app_timezone, main_goal_app, has_pcos,
        last_activity_at, app_synced_at, created_at)
     VALUES
       (:phone, ${withAppPhone ? ":appPhone, " : ""}:email, :name, :appUserId, :lang, 'app', 'visitor', 'new',
        :appAccount, :appOwner, :tz, :goal, :hasPcos,
        NOW(), NOW(), NOW())`;
  const insertParams = {
      replacements: {
        appPhone: normalizedPhone || null,
        phone: phoneTaken ? null : (normalizedPhone || null),
        email: email || null,
        name: name || null,
        appUserId: String(app_user_id),
        appOwner: appOwner,
        appAccount: appAccount,
        lang: language || "en",
        tz: timezone || null,
        goal: mainGoal || null,
        hasPcos: has_pcos ? 1 : 0,
      },
    };
  let insertResult;
  try {
    [insertResult] = await sequelize.query(insertSql(true), insertParams);
  } catch (e) {
    if (!/app_phone/.test(e.message)) throw e;      // migration 036 not run yet
    [insertResult] = await sequelize.query(insertSql(false), insertParams);
  }

  // Sequelize + MySQL returns the new id as a plain number for a raw INSERT
  // (not { insertId }). Reading .insertId gave undefined, so every new app
  // lead was inserted and then the handler crashed (profile never saved).
  // Fall back to the app_user_id we just wrote if neither shape is there.
  const newId = require("../utils/insertId").insertIdOf(insertResult);
  const [created] = newId
    ? await sequelize.query(`SELECT * FROM leads WHERE id = :id`, { replacements: { id: newId } })
    : await sequelize.query(`SELECT * FROM leads WHERE app_user_id = :a ORDER BY id DESC LIMIT 1`, { replacements: { a: String(app_user_id) } });
  if (!created[0]) throw new Error("Lead insert succeeded but the new lead could not be read back");

  // Which door she came through (migration 038). Done as a separate statement
  // so the insert above keeps its two existing shapes, and swallowed if the
  // migration hasn't run — nothing here depends on the gate being recorded.
  // Which door she came through, and who is responsible right now. Separate
  // statement so the insert above keeps its two existing shapes, and swallowed
  // so a DB missing migration 031 or 038 still works.
  await sequelize.query(
    `UPDATE leads
        SET entry_gate = COALESCE(entry_gate, 'app_signup'),
            owner_type = COALESCE(owner_type, :ownerType),
            owner_assigned_at = COALESCE(owner_assigned_at, NOW())
      WHERE id = :id`,
    { replacements: { id: created[0].id, ownerType: appOwner ? "rep" : "app" } }
  ).catch(() => {});
  for (const c of clues) {
    try {
      await sequelize.query(
        `INSERT IGNORE INTO lead_match_suggestions (lead_id, candidate_lead_id, reason, detail) VALUES (:a, :b, :r, :d)`,
        { replacements: { a: created[0].id, b: c.lead.id, r: c.reason, d: c.detail } }
      );
      await writeActivity(c.lead.id, "possible_match", "app", { app_lead: created[0].id, reason: c.reason });
    } catch (e) { console.warn(`[identity] suggestion ${created[0].id}~${c.lead.id} not saved: ${e.message}`); }
  }
  if (clues.length) console.log(`🔎 [identity] app user ${app_user_id} → new lead ${created[0].id}, possible match: ${clues.map((c) => `#${c.lead.id} (${c.reason})`).join(", ")}`);
  return { lead: created[0], created: true, matchedBy: "new", possibleMatches: clues.map((c) => c.lead.id) };
}

// ────────────────────────────────────────────────────────────────
// EVENT HANDLERS
// ────────────────────────────────────────────────────────────────

async function handleUserSignup(payload) {
  const { lead, created, matchedBy } = await findOrLinkLead(payload);

  // Keep both numbers: the one she typed in the app goes to app_phone when it
  // differs from her WhatsApp number on this lead (never overwrites phone).
  const typed = payload.phone ? normalizePhoneDigits(payload.phone) : null;
  if (typed && typed !== lead.phone) {
    await sequelize.query(
      "UPDATE leads SET app_phone = COALESCE(app_phone, :p) WHERE id = :id",
      { replacements: { p: typed, id: lead.id } }
    ).catch((e) => { if (!/app_phone/.test(e.message)) throw e; }); // before migration 036
  }

  // Update profile fields
  await sequelize.query(
    `UPDATE leads
        SET name = COALESCE(:name, name),
            email = COALESCE(:email, email),
            app_timezone = COALESCE(:tz, app_timezone),
            main_goal_app = COALESCE(:goal, main_goal_app),
            target_weight_kg = COALESCE(:tw, target_weight_kg),
            has_pcos = GREATEST(has_pcos, :pcos),
            app_signed_up_at = COALESCE(app_signed_up_at, :signedUpAt),
            app_onboarding_step = GREATEST(COALESCE(app_onboarding_step, 0), :step),
            app_onboarded_at = COALESCE(app_onboarded_at, :onboardedAt),
            app_synced_at = NOW()
      WHERE id = :id`,
    {
      replacements: {
        id: lead.id,
        signedUpAt: sqlUtc(payload.occurred_at || Date.now()),
        step: Number(payload.onboarding_step) || 0,
        onboardedAt: payload.onboarding_done ? sqlUtc(payload.occurred_at || Date.now()) : null,
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
  // App-born leads fire "app_lead_created", NOT "lead_created": the
  // "New Lead Welcome" WhatsApp rule listens to lead_created, and a woman
  // moving forward in the app is owned by the app (journey-architecture.md).
  if (created) {
    await fireEvent(lead.id, "app_lead_created", { source: "app", app_user_id: payload.app_user_id });
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
        startedAt: sqlUtc(payload.started_at || Date.now()),
        expiresAt: sqlUtc(payload.expires_at),
        amount: payload.amount || 0,
        currency: payload.currency || "PKR",
        pkrAmount: payload.currency === "USD"
          ? Number(payload.amount || 0) * 280  // rough conversion; refine in v2
          : Number(payload.amount || 0),
      },
    }
  );

  // One purchase = one event = one WhatsApp. writeActivity("payment_completed")
  // already fires "payment_success" (activity.service.js). The extra
  // subscription_started + payment_success fires used to send the customer
  // "Payment confirmed" AND "Subscription welcome" for the same payment.
  await writeActivity(lead.id, "payment_completed", "app", payload);
  // Paid: every sales task for her closes (sales stops after payment).
  await require("../services/owner.service").resolve(lead.id, undefined, "paid");

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
        expiresAt: sqlUtc(payload.expires_at),
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
  // Reverse rep credit while subscription is frozen
  try {
    const { reverseConversion } = require("../services/repAttribution.service");
    await reverseConversion(lead.id, "subscription_frozen");
  } catch (e) { console.error("[handleSubscriptionFrozen] reversal failed:", e.message); }
  // Create owner task so rep follows up
  try {
    const owner = require("../services/owner.service");
    await owner.escalate(lead.id, "subscription_frozen", { payload });
  } catch (e) { console.error("[handleSubscriptionFrozen] escalate failed:", e.message); }
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
  const reason = payload.reason || "expired";
  await sequelize.query(
    `UPDATE leads
        SET subscription_status = :reason,
            stage = 'churned',
            churn_trigger = 'subscription_expired',
            app_synced_at = NOW()
      WHERE id = :id`,
    { replacements: { id: lead.id, reason } }
  );
  // Reverse rep credit — subscription ended
  try {
    const { reverseConversion } = require("../services/repAttribution.service");
    await reverseConversion(lead.id, `subscription_${reason}`);
  } catch (e) { console.error("[handleSubscriptionExpired] reversal failed:", e.message); }
  // Only subscription_expired ("Expiration Win-back" rule). churn_detected is
  // for churnJob (repeated failed payments); firing both sent two win-backs.
  await fireEvent(lead.id, "subscription_expired", payload);
  return { leadId: lead.id };
}

// Trial started in the app (Nov 2026). She's still a lead, now on a trial.
// Don't downgrade a paying customer if events arrive late.
async function handleTrialStarted(payload) {
  const { lead } = await findOrLinkLead(payload);
  await sequelize.query(
    `UPDATE leads
        SET subscription_status = 'trial', app_synced_at = NOW()
      WHERE id = :id AND subscription_status IN ('none', 'expired', 'cancelled')`,
    { replacements: { id: lead.id } }
  );
  await writeActivity(lead.id, "trial_started", "app", payload);
  await fireEvent(lead.id, "trial_started", payload);
  await require("../services/owner.service").resolve(lead.id, ["onboarding_stalled"], "started_trial");
  return { leadId: lead.id };
}

// Trial ended without a purchase. Only touches leads still marked 'trial',
// so a woman who already paid stays 'active'.
async function handleTrialEnded(payload) {
  const { lead } = await findOrLinkLead(payload);
  await sequelize.query(
    `UPDATE leads
        SET subscription_status = 'expired', app_synced_at = NOW()
      WHERE id = :id AND subscription_status = 'trial'`,
    { replacements: { id: lead.id } }
  );
  await writeActivity(lead.id, "trial_ended", "app", payload);
  await fireEvent(lead.id, "trial_ended", payload);
  return { leadId: lead.id };
}

// Finished the app's sign-up questions (Nov 2026). Her goal and health
// answers become the lead's profile, so Fiza and the rep sell on them.
async function handleOnboardingCompleted(payload) {
  const { lead } = await findOrLinkLead(payload);
  const conditions = String(payload.health_conditions || "").toLowerCase();
  const pcos = payload.has_pcos || conditions.includes("pcos") || conditions.includes("pcod") ? 1 : 0;
  await sequelize.query(
    `UPDATE leads
        SET app_onboarded_at = COALESCE(app_onboarded_at, :at),
            app_onboarding_step = :step,
            main_goal_app = COALESCE(:goal, main_goal_app),
            has_pcos = GREATEST(has_pcos, :pcos),
            app_synced_at = NOW()
      WHERE id = :id`,
    {
      replacements: {
        id: lead.id,
        at: sqlUtc(payload.occurred_at || Date.now()),
        step: Number(payload.onboarding_steps_total) || Number(payload.onboarding_step) || 6,
        goal: payload.main_goal || payload.mainGoal || null,
        pcos,
      },
    }
  );
  await writeActivity(lead.id, "onboarding_completed", "app", {
    main_goal: payload.main_goal || null,
    health_conditions: payload.health_conditions || null,
    age: payload.age || null,
    weight: payload.weight || null,
    height: payload.height || null,
  });
  await fireEvent(lead.id, "onboarding_completed", payload);
  await require("../services/owner.service").resolve(lead.id, ["onboarding_stalled"], "finished_signup");
  return { leadId: lead.id };
}

// She made an app account 20 h+ ago and stopped before the last sign-up
// question (Nov 2026). Ignored if she has finished since. Pushes her rep
// with what to do; automation rules can also act on "onboarding_stalled".
async function handleOnboardingStalled(payload) {
  const { lead } = await findOrLinkLead(payload);
  const [rows] = await sequelize.query(
    "SELECT id, name, phone, assigned_to, app_onboarded_at, subscription_status FROM leads WHERE id = :id",
    { replacements: { id: lead.id } }
  );
  const row = rows[0] || {};
  if (row.app_onboarded_at || ["active", "frozen"].includes(row.subscription_status)) {
    return { leadId: lead.id, ignored: "already onboarded or paying" };
  }
  const step = Number(payload.onboarding_step) || 0;
  const total = Number(payload.onboarding_steps_total) || 6;
  await sequelize.query(
    `UPDATE leads
        SET app_onboarding_step = GREATEST(COALESCE(app_onboarding_step, 0), :step),
            app_onboarding_stalled_at = COALESCE(app_onboarding_stalled_at, NOW()),
            app_synced_at = NOW()
      WHERE id = :id`,
    { replacements: { id: lead.id, step } }
  );
  await writeActivity(lead.id, "onboarding_stalled", "app", {
    stopped_at_step: step,
    steps_total: total,
    can_push: !!payload.can_push,
    has_phone: !!row.phone,
  });
  await fireEvent(lead.id, "onboarding_stalled", payload);

  // Owner rule: give her an owner and the rep a task (push first, rep second).
  const owner = await require("../services/owner.service").escalate(lead.id, "onboarding_stalled", {
    step,
    total,
    appPushedAt: payload.app_reminder_sent_at || null,
    canPush: payload.can_push !== false,
  });
  return { leadId: lead.id, owner: owner.action };
}

// The app linked her to a CRM lead (rep's payment / trial link). The linking
// itself happens in findOrLinkLead via payload.crm_lead_id.
async function handleIdentityLinked(payload) {
  const { lead, matchedBy } = await findOrLinkLead(payload);
  return { leadId: lead.id, matchedBy };
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
  // One door (services/frontDesk.js); it also bumps her unread count.
  await require("../services/frontDesk").saveMessage({
    contact: lead,
    direction: "IN",
    channel: "app",
    from: "user",
    text: body || null,
    accountId: lead.whatsapp_account_id || 1,
    messageType: image_url ? "image" : "text",
    mediaUrl: image_url || null,
  });

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
        SET last_activity_at = NOW(),
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

  // 5b. Owner rule: Fiza asked her for her WhatsApp number (no phone on
  //     file). If this message contains a Pakistani mobile number, save it
  //     and hand her to a rep. Only fills an EMPTY phone, never overwrites.
  try {
    if (!lead.phone && text) {
      const m = text.replace(/[\s-]/g, "").match(/(?:\+?92|0)?3\d{9}/);
      if (m) {
        const digits = normalizePhoneDigits(m[0]);
        if (digits) {
          await sequelize.query("UPDATE leads SET phone = :p WHERE id = :id AND (phone IS NULL OR phone = '')", {
            replacements: { p: digits, id: lead.id },
          });
          await writeActivity(lead.id, "phone_shared", "app", { via: "support_message" });
          await require("../services/owner.service").onPhoneAdded(lead.id);
        }
      }
    }
  } catch (e) {
    // e.g. the number already belongs to another lead on this WhatsApp number
    console.error("[support_issue] phone from message not saved:", e.message);
  }

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

// ── Support ticket follow-ups (Nov 2026) ─────────────────────────
// partner_backend sends these after the first support_issue, so the whole
// ticket thread shows in the lead's chat (channel 'app'):
//   support_issue_reply         the client wrote again on her ticket
//   support_issue_admin_update  staff (admin or a sales rep, from the admin
//                               portal or the CRM tickets panel) replied
//                               and/or changed the status
//   support_issue_feedback      the client said "solved" / "not solved"
// payload always has { ticket_id, app_user_id }.

// App chat message through the one door (services/frontDesk.js). IN bumps
// her unread count there; OUT is saved as read.
async function insertAppMessage(lead, { from, direction, body, imageUrl }) {
  await require("../services/frontDesk").saveMessage({
    contact: lead,
    direction,
    channel: "app",
    from,
    text: body || null,
    accountId: lead.whatsapp_account_id || 1,
    messageType: imageUrl ? "image" : "text",
    mediaUrl: imageUrl || null,
  });
}

async function setIssueStatus(leadId, status, note = null) {
  if (status === "resolved") {
    await sequelize.query(
      `UPDATE app_issues SET status = 'resolved', resolved_note = COALESCE(:note, resolved_note), resolved_at = NOW()
        WHERE lead_id = :lead AND status = 'open'`,
      { replacements: { lead: leadId, note } }
    ).catch((e) => console.error("[ticket] app_issues resolve failed:", e.message));
    await sequelize.query("UPDATE leads SET is_escalated = 0 WHERE id = :id", { replacements: { id: leadId } });
  } else {
    // Re-open her most recent issue (she wrote again / said "not solved").
    await sequelize.query(
      `UPDATE app_issues SET status = 'open', resolved_at = NULL
        WHERE lead_id = :lead AND status = 'resolved'
        ORDER BY created_at DESC LIMIT 1`,
      { replacements: { lead: leadId } }
    ).catch((e) => console.error("[ticket] app_issues reopen failed:", e.message));
    await sequelize.query("UPDATE leads SET is_escalated = 1 WHERE id = :id", { replacements: { id: leadId } });
  }
}

async function handleSupportReply(payload) {
  const { app_user_id, ticket_id, message, image_url } = payload || {};
  const text = message ? String(message).trim() : "";
  if (!text && !image_url) throw new Error("message or image_url is required for support_issue_reply");
  const { lead } = await findOrLinkLead({ app_user_id });
  await insertAppMessage(lead, { from: "user", direction: "IN", body: `[Ticket #${ticket_id}] ${text}`.trim(), imageUrl: image_url, isRead: false });
  await sequelize.query(
    `UPDATE leads SET last_activity_at = NOW() WHERE id = :id`, // unread: frontDesk
    { replacements: { id: lead.id } }
  );
  await setIssueStatus(lead.id, "open");
  await writeActivity(lead.id, "message_received", "app", { kind: "support_issue_reply", ticket_id: ticket_id || null, has_image: !!image_url });
  return { leadId: lead.id };
}

const TICKET_STATUS_LABEL = { received: "New", in_review: "In review", resolved: "Resolved" };

async function handleSupportAdminUpdate(payload) {
  const { app_user_id, ticket_id, message, status, agent_name } = payload || {};
  const { lead } = await findOrLinkLead({ app_user_id });
  const text = message ? String(message).trim() : "";
  if (text) {
    const who = agent_name ? `${agent_name}: ` : "";
    await insertAppMessage(lead, { from: "rep", direction: "OUT", body: `[Ticket #${ticket_id}] ${who}${text}`, isRead: true });
    await sequelize.query("UPDATE leads SET last_message_at = NOW(), last_activity_at = NOW() WHERE id = :id", { replacements: { id: lead.id } });
  }
  if (status === "resolved") await setIssueStatus(lead.id, "resolved", text || null);
  await writeActivity(lead.id, "support_ticket_updated", "app", {
    ticket_id: ticket_id || null,
    status: status ? TICKET_STATUS_LABEL[status] || status : null,
    by: agent_name || null,
    replied: !!text,
  });
  return { leadId: lead.id };
}

async function handleSupportFeedback(payload) {
  const { app_user_id, ticket_id, solved } = payload || {};
  const { lead } = await findOrLinkLead({ app_user_id });
  const ok = solved === true || solved === "true";
  await setIssueStatus(lead.id, ok ? "resolved" : "open");
  await writeActivity(lead.id, "support_ticket_feedback", "app", { ticket_id: ticket_id || null, solved: ok });
  if (!ok) {
    await sequelize.query(
      `UPDATE leads SET unread_count = unread_count + 1, last_activity_at = NOW() WHERE id = :id`,
      { replacements: { id: lead.id } }
    );
  }
  return { leadId: lead.id };
}

const HANDLERS = {
  user_signup:           handleUserSignup,
  support_issue:         handleSupportIssue,
  app_message:           handleSupportIssue, // alias
  support_issue_reply:        handleSupportReply,
  support_issue_admin_update: handleSupportAdminUpdate,
  support_issue_feedback:     handleSupportFeedback,
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
  trial_started:         handleTrialStarted,
  trial_ended:           handleTrialEnded,
  onboarding_completed:  handleOnboardingCompleted,
  onboarding_stalled:    handleOnboardingStalled,
  identity_linked:       handleIdentityLinked,
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
                app_user_id = :appUserId, event_type = :eventType,
                error_message = NULL, received_at = NOW(), processed_at = NULL
          WHERE event_id = :id`,
        { replacements: { id: eventId, payload: JSON.stringify(payload), occurredAt: sqlUtc(occurredAt), appUserId, eventType } }
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
            occurredAt: sqlUtc(occurredAt),
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
      { replacements: { appUserId, types: STATE_EVENTS, occurredAt: sqlUtc(occurredAt), eventId } }
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

module.exports = { dispatchEvent, HANDLERS, linkByCrmLeadId, findOrLinkLead, matchByContact };
