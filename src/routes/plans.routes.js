/**
 * plans.routes.js — endpoint for the magic link modal to fetch country-filtered plans.
 *
 *   GET /api/leads/:leadId/available-plans
 *     Returns: {
 *       detectedCountry, detectedCountryName, detectedCurrency,
 *       recommendedPlans:  [...]  // plans for the lead's country
 *       allCountriesPlans: [...]  // every country's plans, for manual override
 *     }
 *
 * The "Show all countries" toggle in the modal flips between recommended and all.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const { People } = require('../../models');
const { detectCountry, getCountryName, getCountryCurrency } = require('../services/phoneCountry');
const { getPlansForCountry, getAllCountriesPlans } = require('../services/partnerPlans.service');
const { assertOwnsOr403 } = require('../middleware/leadOwnership');

router.get('/:leadId/available-plans', auth, async (req, res) => {
  try {
    const lead = await People.findByPk(req.params.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!assertOwnsOr403(req, res, lead)) return;

    const phone = lead.phone || lead.whatsapp_jid?.split('@')[0] || null;
    const detectedCountry = detectCountry(phone);
    const detectedCountryName = getCountryName(detectedCountry);
    const detectedCurrency = getCountryCurrency(detectedCountry);

    // Fetch plans in parallel (both calls share the same underlying cache)
    let recommendedPlans = [];
    let allCountriesPlans = [];
    try {
      if (detectedCountryName) {
        recommendedPlans = await getPlansForCountry(detectedCountryName);
      }
      allCountriesPlans = await getAllCountriesPlans();
    } catch (err) {
      console.error('Failed to fetch plans from partner_backend:', err.message);
      return res.status(502).json({
        error: 'Could not load plans from app backend',
        detectedCountry,
        detectedCountryName,
        detectedCurrency,
        recommendedPlans: [],
        allCountriesPlans: [],
      });
    }

    return res.json({
      detectedCountry,
      detectedCountryName,
      detectedCurrency,
      recommendedPlans,
      allCountriesPlans,
    });
  } catch (err) {
    console.error('available-plans error:', err);
    return res.status(500).json({ error: 'Failed to load plans' });
  }
});

module.exports = router;
