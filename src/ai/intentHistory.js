/**
 * intentHistory.js - safe helpers for the People.intent_history JSON column.
 *
 * Why this exists:
 *   Sequelize sometimes returns JSON columns as strings instead of arrays
 *   (depends on MySQL connector + how the row was loaded). All callers used
 *   to do `Array.isArray(person.intent_history)` which silently returned
 *   FALSE for strings and started a fresh empty array. Result: every Layer
 *   1 / Layer 2 / manual_override update was overwriting prior history.
 *   By the end of a 6-turn conversation only 1 entry remained.
 *
 * Use loadHistory() everywhere you read intent_history, and pass its result
 * straight to a slice() before unshifting a new entry.
 */

function loadHistory(personOrRow) {
  if (!personOrRow) return [];
  const raw = personOrRow.intent_history;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

module.exports = { loadHistory };
