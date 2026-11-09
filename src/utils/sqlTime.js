/**
 * sqlUtc — a date for raw SQL replacements, as a UTC "YYYY-MM-DD HH:MM:SS.mmm".
 *
 * Why: Sequelize formats a JS Date in a raw-query replacement in the
 * SERVER's local time zone (a Pakistan-time machine stored +5 h), and an ISO
 * string like "2026-11-09T00:15:57.003Z" is rejected by MySQL/MariaDB in
 * strict mode. NOW() and the ORM use UTC, so raw writes must too.
 * Accepts a Date, an ISO string or a timestamp. Invalid / empty → null.
 */
function sqlUtc(v) {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 23).replace("T", " ");
}
module.exports = { sqlUtc };
