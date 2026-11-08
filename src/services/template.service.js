/**
 * template.service.js — bilingual template resolver + placeholder filler.
 *
 * Channel-agnostic: templates are fetched by name + channel + language.
 * The engine passes the channel so the right template variant is loaded.
 */

const { MessageTemplate } = require("../../models");

/**
 * resolveBilingual — fetches the correct template for a language + channel.
 *
 * Convention: templates are named with _en / _ur suffix.
 * e.g. baseName="followup_1", language="ur" → fetches "followup_1_ur"
 *
 * Falls back to "en" if the requested language template doesn't exist.
 *
 * @param {string} baseName  — e.g. "followup_1" or full name "followup_1_ur"
 * @param {string} language  — "en" | "ur"
 * @param {string} channel   — "whatsapp" | "instagram" | "email"
 */
async function resolveBilingual(baseName, language = "en", channel = "whatsapp") {
  // If baseName already has a language suffix, use it directly
  const hasLangSuffix = baseName.endsWith("_en") || baseName.endsWith("_ur");
  const templateName = hasLangSuffix ? baseName : `${baseName}_${language}`;

  // active: 1 everywhere — a disabled template is treated as if it does not
  // exist, so the engine will fall back (or fail loudly) rather than send it.
  let template = await MessageTemplate.findOne({
    where: { name: templateName, channel, active: 1 },
  });

  // Fallback: try English if requested language not found (or disabled)
  if (!template && language !== "en") {
    const fallbackName = hasLangSuffix
      ? baseName.replace(/_ur$/, "_en")
      : `${baseName}_en`;

    console.warn(
      `⚠️  [Template] "${templateName}" not found/active for channel "${channel}" — ` +
      `falling back to "${fallbackName}"`
    );

    template = await MessageTemplate.findOne({
      where: { name: fallbackName, channel, active: 1 },
    });
  }

  // Fallback: try any channel if specific channel not found (or disabled)
  if (!template) {
    template = await MessageTemplate.findOne({ where: { name: templateName, active: 1 } });
  }

  return template || null;
}

/**
 * fillPlaceholders — replaces {{name}}, {{phone}} etc with real person data.
 *
 * @param {string} body    — template body text
 * @param {object} person  — People model instance
 * @param {object} extra   — optional extra vars e.g. { class_name: "Yoga Flow" }
 */
function fillPlaceholders(body, person, extra = {}) {
  const vars = {
    name:        person.name       || person.phone || "there",
    phone:       person.phone      || "",
    email:       person.email      || "",
    stage:       person.stage      || "",
    lead_score:  person.lead_score || 0,
    ...extra,
  };

  return body.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? String(vars[key]) : match;
  });
}

module.exports = { resolveBilingual, fillPlaceholders };
