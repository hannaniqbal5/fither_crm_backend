/**
 * workingHours.js — Phase 9 working-hours helper.
 *
 * Pakistan Standard Time = UTC+05:00. We don't observe DST.
 * Default working window: 9 AM – 9 PM PKT, every day.
 *
 * All exports take or return JS Date objects in UTC; the conversion
 * happens internally.
 */

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

function defaultStartHour() {
  return parseInt(process.env.REP_SHIFT_START_HOUR || "9", 10);
}
function defaultEndHour() {
  return parseInt(process.env.REP_SHIFT_END_HOUR || "21", 10);
}

/**
 * Returns the PKT-equivalent hour (0-23) for a given UTC Date.
 */
function pktHour(date = new Date()) {
  return new Date(date.getTime() + PKT_OFFSET_MS).getUTCHours();
}

/**
 * True if `date` falls within working hours (inclusive of start, exclusive of end).
 */
function isInWindow(date = new Date(), startHour = defaultStartHour(), endHour = defaultEndHour()) {
  const h = pktHour(date);
  return h >= startHour && h < endHour;
}

/**
 * Given a UTC date, returns the 9 AM PKT instant on the SAME PKT day.
 */
function pktDayStart(date = new Date(), startHour = defaultStartHour()) {
  const pkt = new Date(date.getTime() + PKT_OFFSET_MS);
  pkt.setUTCHours(startHour, 0, 0, 0);
  return new Date(pkt.getTime() - PKT_OFFSET_MS);
}
function pktDayEnd(date = new Date(), endHour = defaultEndHour()) {
  const pkt = new Date(date.getTime() + PKT_OFFSET_MS);
  pkt.setUTCHours(endHour, 0, 0, 0);
  return new Date(pkt.getTime() - PKT_OFFSET_MS);
}

/**
 * clampToWindow(fromDate, toDate)
 *  → returns the number of minutes between fromDate and toDate that fall
 *    inside the 9-9 PKT working window, summed across days.
 *
 * If a message arrived at 8 PM and was answered at 9:05 AM the next day,
 * this returns 5 (the 5 minutes in-window after 9 AM), not 13 hours.
 */
function minutesInWindow(fromDate, toDate, startHour = defaultStartHour(), endHour = defaultEndHour()) {
  if (!(fromDate instanceof Date)) fromDate = new Date(fromDate);
  if (!(toDate   instanceof Date)) toDate   = new Date(toDate);
  if (toDate <= fromDate) return 0;

  // Step minute by minute is O(diff_minutes). For most CRM message gaps
  // (< 24h, so ≤ 1440 iterations) this is plenty fast.
  // For longer gaps we walk in 1-hour chunks then minute-precision the edges.
  let total = 0;

  const stepMs = 60 * 1000;
  let cursor = new Date(fromDate.getTime());
  while (cursor < toDate) {
    if (isInWindow(cursor, startHour, endHour)) total += 1;
    cursor = new Date(cursor.getTime() + stepMs);
  }
  return total;
}

/**
 * Faster overlap calculation for long durations:
 * Sum the overlap of [from, to] with each day's [startHour, endHour) PKT.
 */
function minutesInWindowFast(fromDate, toDate, startHour = defaultStartHour(), endHour = defaultEndHour()) {
  if (!(fromDate instanceof Date)) fromDate = new Date(fromDate);
  if (!(toDate   instanceof Date)) toDate   = new Date(toDate);
  if (toDate <= fromDate) return 0;

  let total = 0;
  // Iterate per PKT day
  let dayStart = pktDayStart(fromDate, startHour);
  // If fromDate is before today's window, dayStart is the FIRST 9 AM ≤ fromDate's PKT day
  while (dayStart < toDate) {
    const dayEnd = pktDayEnd(dayStart, endHour);
    const overlapStart = fromDate > dayStart ? fromDate : dayStart;
    const overlapEnd   = toDate   < dayEnd   ? toDate   : dayEnd;
    if (overlapEnd > overlapStart) {
      total += Math.round((overlapEnd - overlapStart) / 60000);
    }
    // Advance to next PKT 9 AM
    dayStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  }
  return total;
}

/**
 * If `arrivedAt` is outside the working window, returns the next 9 AM PKT instant.
 * If inside, returns `arrivedAt` unchanged.
 *
 * Used by response-time SLA: a message that comes in at 11 PM gets
 * "started its clock" at 9 AM next morning.
 */
function nextInWindowInstant(arrivedAt, startHour = defaultStartHour(), endHour = defaultEndHour()) {
  if (!(arrivedAt instanceof Date)) arrivedAt = new Date(arrivedAt);
  if (isInWindow(arrivedAt, startHour, endHour)) return arrivedAt;

  // Find the next 9 AM PKT after arrivedAt
  let next = pktDayStart(arrivedAt, startHour);
  if (next <= arrivedAt) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  return next;
}

module.exports = {
  PKT_OFFSET_MS,
  isInWindow,
  pktHour,
  pktDayStart,
  pktDayEnd,
  minutesInWindow,
  minutesInWindowFast,
  nextInWindowInstant,
};
