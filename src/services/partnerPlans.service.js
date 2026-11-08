/**
 * partnerPlans.service.js — fetch the plans + pricing from partner_backend
 * and normalize for CRM use.
 *
 * partner_backend's /admin/get_plans returns plans with countries nested:
 *   {
 *     plans: [{
 *       id, title, shortDescription, longDescription, catId, subId,
 *       countries: [{
 *         name, id, currency,
 *         duration: [{ id, days, priceAmount }]
 *       }]
 *     }]
 *   }
 *
 * This service caches the response for 10 min (PARTNER_PLANS_CACHE_TTL_MS)
 * so the modal doesn't hammer partner_backend on every open.
 */

const PARTNER_URL = process.env.PARTNER_BACKEND_URL || 'http://localhost:9000';
const PARTNER_API_KEY = process.env.PARTNER_API_KEY || null; // for service-to-service auth, optional
const CACHE_TTL_MS = parseInt(process.env.PARTNER_PLANS_CACHE_TTL_MS || (10 * 60 * 1000), 10);

// Module-level cache. Key: 'all' (we cache the whole response and filter in memory)
const cache = {
  data: null,
  fetchedAt: 0,
};

/**
 * Fetch raw plans from partner_backend. Uses a service-to-service strategy:
 * if PARTNER_API_KEY is set, send it; otherwise rely on the endpoint being
 * accessible. The /admin/get_plans endpoint in partner_backend is currently
 * unauthenticated, so this works as-is.
 */
async function fetchRawPlans({ accessToken } = {}) {
  const fresh = cache.data && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS;
  if (fresh) return cache.data;

  const headers = { 'Content-Type': 'application/json' };
  if (accessToken)     headers['accessToken'] = accessToken;
  if (PARTNER_API_KEY) headers['x-api-key']   = PARTNER_API_KEY;

  const resp = await fetch(`${PARTNER_URL.replace(/\/$/, '')}/admin/get_plans`, {
    method: 'GET',
    headers,
  });
  if (!resp.ok) {
    throw new Error(`partner_backend /admin/get_plans returned ${resp.status}`);
  }
  const json = await resp.json();
  if (json.status !== '1' && json.status !== 1) {
    throw new Error(`partner_backend /admin/get_plans status: ${json.status}`);
  }

  // The 'data' field can be either { plans: [...] } or a direct array — handle both
  const plansRaw = Array.isArray(json.data) ? json.data
                 : Array.isArray(json.data?.plans) ? json.data.plans
                 : [];

  cache.data = plansRaw;
  cache.fetchedAt = Date.now();
  return plansRaw;
}

/**
 * Normalize the partner_backend response into per-country plan lists.
 * Returns an object: { [countryIsoOrName]: [normalizedPlans] }
 *
 * Each normalized plan:
 *   { planId, title, shortDescription, currency,
 *     durations: [{ priceDurationId, days, label, price }] }
 */
function normalizeByCountry(plansRaw) {
  const byCountry = {};

  for (const plan of plansRaw) {
    const planMeta = {
      planId:           plan.id,
      title:            plan.title,
      shortDescription: plan.shortDescription || plan.longDescription || '',
    };

    const countryEntries = plan.countries || plan.Countries || [];
    for (const c of countryEntries) {
      const countryName = c.name || c.countryName;
      if (!countryName) continue;

      const currency = c.currency || c.currencyCode || null;
      const rawDurations = c.duration || c.durations || [];

      const durations = rawDurations.map((d) => {
        const days = parseInt(String(d.days || '').match(/\d+/)?.[0] || '0', 10);
        const months = Math.round(days / 30) || null;
        return {
          priceDurationId: d.id,
          days,
          months,
          label:           months ? `${months}-month` : (d.days || `${days} days`),
          price:           parseInt(d.priceAmount || d.price || '0', 10) || 0,
        };
      }).filter(d => d.price > 0);

      if (durations.length === 0) continue;

      if (!byCountry[countryName]) byCountry[countryName] = [];
      byCountry[countryName].push({
        ...planMeta,
        currency,
        durations,
      });
    }
  }

  return byCountry;
}

/**
 * Get plans available for a specific country name (case-insensitive).
 * Returns array of normalized plans, or [] if no plans for that country.
 */
async function getPlansForCountry(countryName, opts = {}) {
  if (!countryName) return [];
  const raw = await fetchRawPlans(opts);
  const byCountry = normalizeByCountry(raw);
  const target = countryName.toLowerCase();
  for (const [name, plans] of Object.entries(byCountry)) {
    if (name.toLowerCase() === target) return plans;
  }
  return [];
}

/**
 * Get plans for ALL countries — used for the "manual override" view in the modal.
 * Returns array of { country, currency, plans }.
 */
async function getAllCountriesPlans(opts = {}) {
  const raw = await fetchRawPlans(opts);
  const byCountry = normalizeByCountry(raw);
  return Object.entries(byCountry).map(([country, plans]) => ({
    country,
    currency: plans[0]?.currency || null,
    plans,
  }));
}

function invalidateCache() {
  cache.data = null;
  cache.fetchedAt = 0;
}

module.exports = {
  fetchRawPlans,
  normalizeByCountry,
  getPlansForCountry,
  getAllCountriesPlans,
  invalidateCache,
};
