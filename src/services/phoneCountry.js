/**
 * phoneCountry.js — detect a country from a phone number.
 *
 * Wraps libphonenumber-js so callers don't have to deal with parsing quirks.
 * Defaults to Pakistan (PK) when the number can't be parsed reliably, since
 * that's FitHer's primary market.
 *
 * Usage:
 *   const { detectCountry, getCountryName, getCountryCurrency } = require('../services/phoneCountry');
 *   detectCountry('923034108093')   → 'PK'
 *   detectCountry('+971501234567')  → 'AE'
 *   detectCountry('0345 1234567')   → 'PK' (assumed local)
 *   detectCountry(null)             → null
 */

const { parsePhoneNumberFromString } = require('libphonenumber-js');

const DEFAULT_COUNTRY = 'PK'; // FitHer's primary market — used as fallback / parsing hint

// Map from ISO country code → display name + currency
// Extend as you grow into new markets.
const COUNTRY_META = {
  PK: { name: 'Pakistan',           currency: 'PKR' },
  AE: { name: 'UAE',                currency: 'AED' },
  SA: { name: 'Saudi Arabia',       currency: 'SAR' },
  US: { name: 'USA',                currency: 'USD' },
  GB: { name: 'UK',                 currency: 'GBP' },
  CA: { name: 'Canada',             currency: 'CAD' },
  AU: { name: 'Australia',          currency: 'AUD' },
  IN: { name: 'India',              currency: 'INR' },
  BD: { name: 'Bangladesh',         currency: 'BDT' },
  MY: { name: 'Malaysia',           currency: 'MYR' },
  ID: { name: 'Indonesia',          currency: 'IDR' },
  QA: { name: 'Qatar',              currency: 'QAR' },
  OM: { name: 'Oman',               currency: 'OMR' },
  KW: { name: 'Kuwait',             currency: 'KWD' },
  BH: { name: 'Bahrain',            currency: 'BHD' },
};

/**
 * detectCountry — returns the ISO 3166 alpha-2 country code for a phone number.
 * Returns null if no number provided, or DEFAULT_COUNTRY if parsing fails entirely.
 */
function detectCountry(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  const cleaned = rawPhone.trim();
  if (!cleaned) return null;

  try {
    // Try as-is first (handles "+92...", "00 92...", etc.)
    const phone = parsePhoneNumberFromString(cleaned, DEFAULT_COUNTRY);
    if (phone && phone.country) {
      return phone.country;
    }
  } catch { /* fall through */ }

  try {
    // Try with leading + if it looks like an international number missing the +
    if (/^\d{7,15}$/.test(cleaned)) {
      const phone = parsePhoneNumberFromString('+' + cleaned);
      if (phone && phone.country) return phone.country;
    }
  } catch { /* fall through */ }

  // Final fallback — couldn't tell, assume primary market
  return DEFAULT_COUNTRY;
}

/**
 * normalizePhoneDigits — canonical lead phone: E.164 digits WITHOUT the '+',
 * which is exactly how WhatsApp leads are stored (JID user part, e.g.
 * "923001234567"). Local numbers are read as Pakistan by default.
 *   "03001234567"      → "923001234567"
 *   "+92 300 1234567"  → "923001234567"
 *   "0092 300 1234567" → "923001234567"
 *   "923001234567"     → "923001234567"
 *   "+971501234567" / "971501234567" → "971501234567"
 * Returns null for empty input. Unparseable input falls back to its digits.
 */
function normalizePhoneDigits(rawPhone, defaultCountry = DEFAULT_COUNTRY) {
  if (rawPhone === null || rawPhone === undefined) return null;
  let s = String(rawPhone).trim();
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;

  const tryParse = (str, country) => {
    try {
      const n = parsePhoneNumberFromString(str, country);
      return n && n.isValid() ? n.number.replace(/^\+/, '') : null;
    } catch { return null; }
  };

  // Explicit international form.
  if (s.startsWith('+')) return tryParse(s) || digits;

  // Bare digits that already carry a country code (no leading 0, ≥11 digits):
  // WhatsApp-style "923001234567" / "971501234567".
  if (!digits.startsWith('0') && digits.length >= 11) {
    const intl = tryParse('+' + digits);
    if (intl) return intl;
  }

  // Local / national format (default country).
  return tryParse(s, defaultCountry) || digits;
}

function getCountryName(iso) {
  if (!iso) return null;
  return COUNTRY_META[iso]?.name || iso;
}

function getCountryCurrency(iso) {
  if (!iso) return null;
  return COUNTRY_META[iso]?.currency || null;
}

function getCountryMeta(iso) {
  return COUNTRY_META[iso] || null;
}

module.exports = {
  detectCountry,
  normalizePhoneDigits,
  getCountryName,
  getCountryCurrency,
  getCountryMeta,
  DEFAULT_COUNTRY,
  COUNTRY_META,
};
