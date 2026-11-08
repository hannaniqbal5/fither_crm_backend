const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { login, logout } = require("../controllers/auth.controller");

const router = express.Router();

// ── Login brute-force protection ───────────────────────────────
// This router is mounted at /api/auth AND /api/admin, so these limiters cover
// both /api/auth/login and /api/admin/login (one shared counter per key).
//
// NOTE: the dashboard tries /api/admin/login FIRST for every user, and sales
// reps (who live in partner_backend) always get a 401 there before falling
// back. A whole call-center office usually shares one public IP, so a strict
// per-IP limit would lock every rep out. Hence:
//   1. per IP + email: 10 failed attempts / 15 min (real brute-force guard)
//   2. per IP:        100 failed attempts / 15 min (spray across many emails)
// Successful logins are not counted. Requires `trust proxy` (set in App.js).
const WINDOW_MS = 15 * 60 * 1000;
const tooMany = { error: "Too many login attempts. Please try again in 15 minutes." };

const loginLimiterPerAccount = rateLimit({
  windowMs: WINDOW_MS,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: tooMany,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    return `${ipKeyGenerator(req.ip)}|${email}`;
  },
});

const loginLimiterPerIp = rateLimit({
  windowMs: WINDOW_MS,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: tooMany,
});

router.post("/login", loginLimiterPerIp, loginLimiterPerAccount, login);
router.post("/logout", logout);

module.exports = router;
