/**
 * repSession.service.js — Phase 9 (B).
 *
 * Manages `rep_sessions` rows. Hooks into the existing socket events
 * (foreground / background / disconnect) and the heartbeat cron.
 *
 * Lifecycle:
 *   1. Rep socket connects DURING working hours
 *      → open new rep_sessions row with state='active'
 *   2. Heartbeat tick (every 1 min)
 *      → if state='active', bump active_minutes
 *      → if state='background', bump background_minutes
 *      → if state='idle', bump idle_minutes
 *      → if last_heartbeat > rep_idle_timeout_minutes ago, transition to 'idle'
 *      → if idle for rep_max_idle_to_close, close the session
 *      → if PKT hour is now ≥ end-hour, close the session
 *   3. Rep socket emits 'background' → state='background'
 *   4. Rep socket emits 'foreground' → state='active', refresh heartbeat
 *   5. Rep socket disconnects → close the session (close_reason='logout')
 *
 * The service is import-safe — calling fn before migration won't crash, just no-ops.
 */

const cron = require("node-cron");
const sequelize = require("../config/database");
const {
  isInWindow,
  pktHour,
} = require("../utils/workingHours");

// In-memory map of currently-open sessions per rep: repId → { sessionId, heartbeatTs, state }
const liveSessions = new Map();

async function getSettings() {
  try {
    const [rows] = await sequelize.query(
      `SELECT setting_key, setting_value FROM layer_system_settings
        WHERE setting_key IN
          ('rep_shift_start_hour','rep_shift_end_hour',
           'rep_idle_timeout_minutes','rep_max_idle_to_close')`
    );
    const m = {};
    rows.forEach(r => { m[r.setting_key] = r.setting_value; });
    return {
      startHour:        parseInt(m.rep_shift_start_hour || "9", 10),
      endHour:          parseInt(m.rep_shift_end_hour || "21", 10),
      idleTimeoutMin:   parseInt(m.rep_idle_timeout_minutes || "5", 10),
      maxIdleToCloseMin: parseInt(m.rep_max_idle_to_close || "60", 10),
    };
  } catch {
    return { startHour: 9, endHour: 21, idleTimeoutMin: 5, maxIdleToCloseMin: 60 };
  }
}

async function openSession(repId) {
  if (!repId) return null;

  const settings = await getSettings();
  const inWindow = isInWindow(new Date(), settings.startHour, settings.endHour);

  // If outside the window, we still record but mark in_window=false (off-shift session)
  try {
    const [result] = await sequelize.query(
      `INSERT INTO rep_sessions
         (rep_id, started_at, last_heartbeat_at, state, in_window)
       VALUES (?, NOW(), NOW(), 'active', ?)`,
      { replacements: [repId, inWindow ? 1 : 0] }
    );
    const sessionId = result?.insertId || result;
    liveSessions.set(repId, {
      sessionId,
      heartbeatTs: Date.now(),
      state: "active",
      inWindow,
    });
    console.log(`⏱  [RepSession] Opened #${sessionId} for rep ${repId} (in_window=${inWindow})`);
    return sessionId;
  } catch (err) {
    console.error("[RepSession] openSession failed:", err.message);
    return null;
  }
}

async function closeSession(repId, reason = "logout") {
  const live = liveSessions.get(repId);
  if (!live) return;

  try {
    await sequelize.query(
      `UPDATE rep_sessions
          SET ended_at = NOW(),
              state    = 'closed',
              close_reason = ?
        WHERE id = ? AND ended_at IS NULL`,
      { replacements: [reason, live.sessionId] }
    );
    liveSessions.delete(repId);
    console.log(`⏱  [RepSession] Closed #${live.sessionId} for rep ${repId} (${reason})`);
  } catch (err) {
    console.error("[RepSession] closeSession failed:", err.message);
  }
}

async function setSessionState(repId, newState) {
  const live = liveSessions.get(repId);
  if (!live) return;
  live.state = newState;
  live.heartbeatTs = Date.now();
  try {
    await sequelize.query(
      `UPDATE rep_sessions SET state = ?, last_heartbeat_at = NOW() WHERE id = ?`,
      { replacements: [newState, live.sessionId] }
    );
  } catch (err) {
    console.error("[RepSession] setSessionState failed:", err.message);
  }
}

function bumpHeartbeat(repId) {
  const live = liveSessions.get(repId);
  if (!live) return;
  live.heartbeatTs = Date.now();
}

async function tickAll() {
  const settings = await getSettings();
  const now = new Date();
  const outOfWindow = !isInWindow(now, settings.startHour, settings.endHour);
  const idleCutoffMs = settings.idleTimeoutMin * 60 * 1000;
  const closeCutoffMs = settings.maxIdleToCloseMin * 60 * 1000;

  for (const [repId, live] of liveSessions.entries()) {
    const sinceHeartbeat = Date.now() - live.heartbeatTs;

    // End-of-day rollover — close any session if we're past 9 PM PKT
    if (outOfWindow && live.inWindow) {
      await closeSession(repId, "end_of_day");
      continue;
    }

    // Idle timeout cascade: active → idle → closed
    if (sinceHeartbeat > closeCutoffMs) {
      await closeSession(repId, "idle_timeout");
      continue;
    }
    if (live.state === "active" && sinceHeartbeat > idleCutoffMs) {
      await setSessionState(repId, "idle");
    }

    // Increment minute counter for the state we're in
    const field =
      live.state === "active"     ? "active_minutes" :
      live.state === "background" ? "background_minutes" :
      live.state === "idle"       ? "idle_minutes" : null;
    if (field) {
      try {
        await sequelize.query(
          `UPDATE rep_sessions SET ${field} = ${field} + 1 WHERE id = ?`,
          { replacements: [live.sessionId] }
        );
      } catch (err) {
        console.error("[RepSession] tick increment failed:", err.message);
      }
    }
  }
}

/**
 * Heartbeat cron — runs every minute.
 */
function startSessionHeartbeat() {
  // No lock: it reads this process's own socket state (who is online).
  cron.schedule("* * * * *", require("../monitor/jobs").wrap("rep-session-heartbeat", () => tickAll(), { lock: false }));
  console.log("✅ [RepSession] Heartbeat scheduled (every minute)");
}

/**
 * Public wiring helpers — called by App.js socket handlers.
 */
async function onSocketConnect(repId) {
  // Reuse open session if rep reconnects within same shift, else open fresh
  if (liveSessions.has(repId)) {
    await setSessionState(repId, "active");
    return;
  }
  await openSession(repId);
}
async function onSocketBackground(repId) {
  await setSessionState(repId, "background");
}
async function onSocketForeground(repId) {
  if (!liveSessions.has(repId)) {
    await openSession(repId);
  } else {
    await setSessionState(repId, "active");
  }
}
async function onSocketDisconnect(repId) {
  await closeSession(repId, "logout");
}

function getLiveSessionId(repId) {
  return liveSessions.get(repId)?.sessionId || null;
}

module.exports = {
  startSessionHeartbeat,
  onSocketConnect,
  onSocketBackground,
  onSocketForeground,
  onSocketDisconnect,
  bumpHeartbeat,
  getLiveSessionId,
  liveSessions,
};
