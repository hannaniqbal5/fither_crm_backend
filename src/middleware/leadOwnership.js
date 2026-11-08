/**
 * leadOwnership.js — shared per-lead ownership check.
 *
 * Logic copied from assertOwnsOr403 in src/routes/layerSystem.routes.js:
 *   - admins (req.user.role === "admin") may act on any lead
 *   - reps may only act on leads where assigned_to === req.user.repId
 */

function isAdmin(req) {
  return req.user?.role === "admin";
}

/**
 * Returns true if the caller may operate on this lead; otherwise sends
 * 403 and returns false.
 */
function assertOwnsOr403(req, res, lead) {
  if (isAdmin(req)) return true;
  if (lead && Number(lead.assigned_to) === Number(req.user?.repId)) return true;
  res.status(403).json({ error: "Not your lead" });
  return false;
}

module.exports = { isAdmin, assertOwnsOr403 };
