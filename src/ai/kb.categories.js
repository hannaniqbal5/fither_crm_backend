/**
 * kb.categories.js — single source of truth for KB chunk categorization.
 *
 * Used by:
 *   - ingest.script.js — to tag each chunk with a category when loading
 *   - retrieval.service.js — to filter chunks by the active Fiza mode
 *
 * Categories are kept coarse (10-15 max) so they're easy to maintain.
 * Each chunk gets ONE category. Each mode allows a set of categories.
 */

// ─── Category → filename/section pattern matchers ──────────────
// Order matters — first match wins.
const CATEGORY_RULES = [
  // Support / troubleshooting (highest priority — these chunks must not leak to sales)
  { category: 'troubleshooting_app',          fileRe: /troubleshooting|app[_\s]*issue/i, sectionRe: /(app|install|crash|login|otp)/i },
  { category: 'troubleshooting_payment',      fileRe: /troubleshooting|app[_\s]*issue/i, sectionRe: /payment|paid|plan\s+active/i },
  { category: 'troubleshooting_class',        fileRe: /troubleshooting|app[_\s]*issue/i, sectionRe: /live\s*class|video|stream|join/i },
  { category: 'troubleshooting_consultation', fileRe: /troubleshooting|app[_\s]*issue/i, sectionRe: /coach|consultation|appointment|booking/i },
  { category: 'troubleshooting_diet',         fileRe: /troubleshooting|app[_\s]*issue/i, sectionRe: /diet\s*plan|meal/i },
  { category: 'troubleshooting_generic',      fileRe: /troubleshooting|app[_\s]*issue/i },

  // Winback / re-engagement
  { category: 'whats_new',     fileRe: /whats[_\s]*new|recent[_\s]*update/i },
  { category: 'return_offer',  fileRe: /winback|return[_\s]*offer/i },
  { category: 'return_offer',  sectionRe: /return\s+(member|offer)|winback|comeback/i },

  // Sales / general (most chunks land here)
  { category: 'pricing',          fileRe: /pricing|payment|onboarding/i },
  { category: 'condition_pcos',   sectionRe: /\bPCOS\b/i },
  { category: 'condition_pcod',   sectionRe: /\bPCOD\b/i },
  { category: 'condition_thyroid', sectionRe: /thyroid/i },
  { category: 'condition_diabetes', sectionRe: /diabet/i },
  { category: 'condition_postpartum', sectionRe: /postpartum|new\s+mother|after\s+(delivery|birth)/i },
  { category: 'weight_loss',      fileRe: /weight[_\s]*loss/i },
  { category: 'programs',         fileRe: /workout|diet|logistics|services/i },
  { category: 'objection_price',  sectionRe: /price\s+objection|mehnga|expensive|too\s+costly/i },
  { category: 'objection_timing', sectionRe: /no\s+time|busy|schedule\s+issue/i },
  { category: 'objection_family', sectionRe: /husband|family\s+(objection|decision)/i },
  { category: 'objections',       fileRe: /objection|motivation/i },
  { category: 'trainers',         fileRe: /trainer|community|support/i },
  { category: 'basic_info',       fileRe: /brand|program/i },
];

const DEFAULT_CATEGORY = 'basic_info';

function categorize(sourceFile, sectionTitle) {
  const file = String(sourceFile || '');
  const section = String(sectionTitle || '');
  for (const rule of CATEGORY_RULES) {
    const fileMatch = rule.fileRe ? rule.fileRe.test(file) : true;
    const sectionMatch = rule.sectionRe ? rule.sectionRe.test(section) : true;
    // Rule requires BOTH conditions to pass (if both defined)
    if (rule.fileRe && rule.sectionRe) {
      if (fileMatch && sectionMatch) return rule.category;
    } else if (rule.fileRe) {
      if (fileMatch) return rule.category;
    } else if (rule.sectionRe) {
      if (sectionMatch) return rule.category;
    }
  }
  return DEFAULT_CATEGORY;
}

// ─── Mode → allowed categories ─────────────────────────────────
const MODE_CATEGORIES = {
  sales: [
    'basic_info',
    'pricing',
    'programs',
    'condition_pcos', 'condition_pcod', 'condition_thyroid', 'condition_diabetes', 'condition_postpartum',
    'weight_loss',
    'objections', 'objection_price', 'objection_timing', 'objection_family',
    'trainers',
  ],
  winback: [
    'pricing',
    'whats_new',
    'return_offer',
    'programs',
    'condition_pcos', 'condition_pcod',
    'weight_loss',
    'objections', 'objection_price',
    // Excluded: basic_info, trainers (returning member already knows)
  ],
  support: [
    'troubleshooting_app',
    'troubleshooting_payment',
    'troubleshooting_class',
    'troubleshooting_consultation',
    'troubleshooting_diet',
    'troubleshooting_generic',
  ],
};

module.exports = {
  CATEGORY_RULES,
  MODE_CATEGORIES,
  categorize,
  DEFAULT_CATEGORY,
};
