/**
 * adminOnly.js — role guard. Use AFTER an auth middleware that sets req.user.
 * Same check as the local adminOnly helpers in admin.routes.js /
 * layerSystem.routes.js: 403 unless req.user.role === "admin".
 */
module.exports = function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};
