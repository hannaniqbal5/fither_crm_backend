/**
 * modeRouter.js — picks which Fiza mode handles a given message.
 *
 * Modes:
 *   - sales:    default — new leads, active prospects, conversion focus
 *   - winback:  customer.stage === 'churned' — returning member, easier conversion
 *   - support:  message contains app-issue keywords — troubleshooting focus
 *
 * Resolution order (first match wins):
 *   1. Support keywords (overrides everything — even a churned customer with an app
 *      issue should get help, not a winback pitch)
 *   2. Churned customer → winback
 *   3. Default → sales
 *
 * Keep this CHEAP — pure regex + flag check, no AI inference. Runs on every
 * inbound message.
 */

// Roman Urdu + English keywords that signal app/technical issues.
// Tune carefully — false positives mean someone trying to buy gets sent
// down the troubleshooting path.
const SUPPORT_KEYWORDS = [
  // App-level problems
  /app\s+(khul|open|chal|launch|load)\s*(nahi|n[a]t|won['’]?t)/i,
  /app\s+(crash|freez|hang|stuck)/i,
  /reinstall|uninstall/i,

  // Login / authentication
  /login\s+(nahi|n[a]t|won['’]?t|cannot)/i,
  /password\s+(reset|nahi|forgot|bhul)/i,
  /(otp|verification\s+code)\s+(nahi|n[a]t|missing|received nahi)/i,

  // Live class / video
  /live\s+class\s+(join|connect)\s+(nahi|n[a]t)/i,
  /video\s+(buffer|lag|black|nahi\s+chal|won['’]?t play|not (loading|playing))/i,
  /class\s+(start|begin)\s+(nahi|n[a]t)/i,
  /screen\s+black/i,
  /audio\s+(nahi|n[a]t|no sound|sound nahi)/i,

  // Payment / plan activation issues (already paid but not working)
  /payment\s+(kar\s+diya|done|completed|hua).*plan\s+(active\s+nahi|nahi\s+chala|nahi\s+hua)/i,
  /plan\s+activate\s+nahi/i,
  /paisa\s+(kat|deduct)\s*(ho)?\s+(gaya|gaye).*plan\s+nahi/i,

  // Booking / slots
  /slot\s+(book|select)\s+(nahi|n[a]t)/i,
  /booking\s+(fail|nahi|n[a]t)/i,

  // Coach / consultation
  /coach\s+(reply\s+nahi|response\s+nahi|jawab\s+nahi)/i,
  /consultation\s+(nahi|n[a]t|missed)/i,
  /diet\s+plan\s+(nahi\s+mila|nahi\s+aya|missing)/i,

  // Generic technical
  /\b(bug|error|glitch|issue|problem|tech(nical)?)\b.*(app|FitHer|platform)/i,
  /\b(crash|freeze|hang|black\s*screen|white\s*screen|loading\s+(forever|hamesha))\b/i,
];

/**
 * Detect support intent from a message.
 * @param {string} text — user's message
 * @returns {{ match: boolean, pattern?: string }}
 */
function detectSupportIntent(text) {
  if (!text || typeof text !== 'string') return { match: false };
  for (const re of SUPPORT_KEYWORDS) {
    if (re.test(text)) {
      return { match: true, pattern: re.source.slice(0, 60) };
    }
  }
  return { match: false };
}

/**
 * pickMode — decides which Fiza mode handles this message.
 *
 * @param {object} lead — People row (or compatible)
 * @param {string} message — latest user message
 * @returns {{ mode: 'sales'|'winback'|'support', reason: string }}
 */
function pickMode(lead, message) {
  // 1. Support intent overrides everything
  const support = detectSupportIntent(message);
  if (support.match) {
    return {
      mode: 'support',
      reason: `support keyword matched: ${support.pattern}`,
    };
  }

  // 2. Churned customer → winback
  if (lead?.stage === 'churned') {
    return {
      mode: 'winback',
      reason: `lead.stage = churned`,
    };
  }

  // 3. Default → sales
  return {
    mode: 'sales',
    reason: 'default — new lead / active prospect',
  };
}

module.exports = {
  pickMode,
  detectSupportIntent,
};
