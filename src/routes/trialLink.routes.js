/**
 * trialLink.routes.js — CRM proxy for sending trial links via partner_backend.
 *
 * POST /api/leads/:leadId/send-trial-link
 *   Body: { expiresInDays? }
 *   → calls partner_backend POST /admin/create-trial-token
 *   → returns { deepLink, token, expiresAt }
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const { People } = require('../../models');
const { assertOwnsOr403 } = require('../middleware/leadOwnership');

const PARTNER_URL = process.env.PARTNER_BACKEND_URL || 'http://localhost:9000';

router.post('/:leadId/send-trial-link', auth, async (req, res) => {
  try {
    const lead = await People.findByPk(req.params.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!assertOwnsOr403(req, res, lead)) return;

    const phone = lead.phone || null;
    const email = lead.email || null;
    const expiresInDays = parseInt(req.body.expiresInDays, 10) || 7;

    // Call partner_backend — use the rep's own JWT so the token is
    // attributed to them in the app backend.
    const jwt = req.headers.authorization;
    const resp = await fetch(`${PARTNER_URL}/admin/create-trial-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(jwt ? { Authorization: jwt } : {}),
      },
      body: JSON.stringify({
        phone,
        email,
        expiresInDays,
        crmLeadId: lead.id,
      }),
    });

    const data = await resp.json();

    if (data.status === '0' || !resp.ok) {
      return res.status(502).json({
        error: data.message || 'App backend refused',
        detail: data,
      });
    }

    // Log it on the lead timeline
    try {
      const { writeActivity } = require('../services/activity.service');
      await writeActivity(lead.id, 'trial_link_sent', 'crm', {
        deepLink: data.data?.deepLink,
        token: data.data?.token,
        sentBy: req.user?.id,
      });
    } catch (e) {
      console.error('[trial-link] activity log failed:', e.message);
    }

    return res.json({
      deepLink: data.data?.deepLink,
      token: data.data?.token,
      expiresAt: data.data?.expiresAt,
      phone,
    });
  } catch (err) {
    console.error('[trial-link] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
