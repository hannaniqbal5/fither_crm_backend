/**
 * phoneKey.js — one way to store a phone, one way to ask "same number?"
 * (Nov 2026).
 *
 *   normalize(raw)  how a phone is SAVED: international digits, no '+'
 *                   ("0300-1234567" → "923001234567"). Every door uses it.
 *   tail10(raw)     the matching key: last 10 digits, or null.
 *   tailSql(alias, { withApp })
 *                   SQL that matches `:tail` against the indexed
 *                   leads.phone_last10 (migration 049). Before 049 runs it
 *                   falls back to the old string-stripping expression, so
 *                   nothing breaks, it's only slower.
 */
const sequelize = require("../config/database");
const { normalizePhoneDigits } = require("./phoneCountry");

function normalize(raw) {
  const n = normalizePhoneDigits(raw);
  const digits = String(n || "").replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}

function tail10(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

const strip = (col) => `RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col},' ',''),'+',''),'-',''),'(',''),')',''),'.',''), 10)`;

let has = null; // { phone, app }
async function columns() {
  if (has) return has;
  try {
    const [rows] = await sequelize.query(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads'
          AND COLUMN_NAME IN ('phone_last10', 'app_phone_last10', 'app_phone')`
    );
    const set = new Set(rows.map((r) => r.c));
    has = { phone: set.has("phone_last10"), app: set.has("app_phone_last10"), appPhone: set.has("app_phone") };
    if (!has.phone) console.warn("[phoneKey] leads.phone_last10 missing: run migration 049_phone_last10.sql (phone matching is slow until then)");
  } catch {
    has = { phone: false, app: false, appPhone: false };
  }
  return has;
}

/** SQL condition: this lead's phone (and optionally app_phone) ends with :tail. */
async function tailSql(alias = "", { withApp = false } = {}) {
  const a = alias ? `${alias}.` : "";
  const c = await columns();
  const phone = c.phone ? `${a}phone_last10 = :tail` : `${strip(`${a}phone`)} = :tail`;
  if (!withApp || !c.appPhone) return phone;
  const app = c.app ? `${a}app_phone_last10 = :tail` : `${strip(`${a}app_phone`)} = :tail`;
  return `(${phone} OR ${app})`;
}

module.exports = { normalize, tail10, tailSql, columns };
