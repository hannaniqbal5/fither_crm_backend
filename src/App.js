// Run in UTC on every machine. The database layer writes JavaScript dates in
// the process's LOCAL zone but reads them back as UTC, so on a PC set to
// Pakistan time every saved date (campaign schedules, expiries…) landed 5 h
// late. Pakistan time is always applied explicitly (Asia/Karachi) where shown.
process.env.TZ = "UTC";
require("dotenv").config();

const express    = require("express");
const cors       = require("cors");
const http       = require("http");
const { Server } = require("socket.io");
const jwt        = require("jsonwebtoken");
const fsSync     = require("fs");
const path       = require("path");
const helmet     = require("helmet");
const multer     = require("multer");

/*******************************
 * PROCESS-LEVEL SAFETY NETS
 *******************************/
// Log stray promise rejections instead of crashing the whole CRM (and every
// Baileys socket) over one forgotten .catch().
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled promise rejection:", reason);
});
// After an uncaught exception the process state is unknown — log and exit so
// PM2 (autorestart: true) restarts a clean process. Short delay lets the log
// reach PM2's pipe.
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception — exiting so PM2 restarts:", err);
  setTimeout(() => process.exit(1), 200);
});

const sequelize = require("./config/database");
// Record every console.error into system_errors (+ optional webhook alert).
require("./monitor/errors").install({ sequelize });
// Which jobs this process runs: "all" (default — everything, as before),
// "web" (WhatsApp-bound jobs only; run src/worker.js for the rest).
const CRM_PROCESS = process.env.CRM_PROCESS || "all";
const RUN_DB_JOBS = CRM_PROCESS !== "web";
const auth      = require("./middleware/auth.middleware");
const adminOnly = require("./middleware/adminOnly");

const {
  People,
  Message,
  SalesRep,
  WhatsAppAccount,
  AssignmentState,
  SalesRepPushToken,
  // Phase 1 new
  Activity,
  Event,
  Integration,
  // Phase 2 new
  AutomationRule,
  AutomationLog,
  MessageTemplate,
} = require("../models");

const cookieParser  = require("cookie-parser");
const leadRoutes    = require("./routes/leads.routes");
const plansRoutes   = require("./routes/plans.routes");
const paymentAccountsRoutes = require("./routes/paymentAccounts.routes");
const authRoutes    = require("./routes/auth.routes");
const messagingAnalyticsRoutes = require("./routes/messagingAnalytics.routes");
const adminRoutes   = require("./routes/admin.routes");
const pushTokenRoutes    = require("./routes/pushTokens");
const automationRoutes  = require("./routes/automation.routes");
const aiRoutes          = require("./routes/ai.routes");        // Phase 3 — AI agent
const metaRoutes        = require("./routes/meta.routes");      // Phase 4 — Instagram + Facebook
const campaignRoutes    = require("./routes/campaign.routes");  // Phase 5 — Marketing campaigns
const autoCampaignRoutes = require("./routes/autoCampaign.routes"); // Auto campaign rules
const autoTakeoverRoutes  = require("./routes/autoTakeover.routes");  // Fiza auto-takeover rules
const automationMetrics   = require("./routes/automationMetrics.routes"); // Automation metrics
const appRoutes         = require("./routes/app.routes");       // Phase 6 — FitHer app integration
const appReadRoutes     = require("./routes/appRead.routes");  // CRM → App read API
const layerSystemRoutes = require("./routes/layerSystem.routes");// Phase 8 — Intent + Funnel Layer System
const repQualityRoutes  = require("./routes/repQuality.routes"); // Phase 9 — Rep Quality scorecard
const aiLearningRoutes  = require("./routes/aiLearning.routes"); // Phase 11 — Fiza Learning Loop
const aiUsageRoutes     = require("./routes/aiUsage.routes");    // Phase 12 — Token usage analytics
const searchRoutes      = require("./routes/search.routes");     // Phase 13 — Universal search
const welcomeAssetsRoutes = require("./routes/welcomeAssets.routes"); // Phase 15a — Welcome asset uploads
const devSimulateRoutes = require("./routes/devSimulate.routes"); // Phase 16 — Dev test endpoint
const numberUploadRoutes = require("./routes/numberUpload.routes");
const fizzaChatsRoutes = require("./routes/fizzaChats.routes"); // Phase 21 — Fizza Chats admin view

// Phase 2 — engine + cron jobs
const { startWorker }         = require("./engine/worker");
const { startInactivityJob }  = require("./jobs/inactivityJob");
const { startChurnJob }       = require("./jobs/churnJob");

const { onlineUsers, repInBackground } = require("../socket/repState");
const { createBaileysClient }          = require("./whatsapp/baileysClient");
const ensureAssignmentState            = require("./utils/ensureAssignmentState");

/*******************************
 * EXPRESS APP
 *******************************/
const app = express();

// Production runs behind nginx (crm.backend.thefither.com). Trust exactly ONE
// proxy hop so req.ip is the real client IP from X-Forwarded-For (needed by the
// login rate limiter). If the app is ever exposed directly without a proxy,
// remove this, otherwise clients can spoof their IP via X-Forwarded-For.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Security headers. CORP must be cross-origin: the dashboard (different
// origin) loads /uploads media and /api/welcome-assets/file/* directly.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// CORS_ORIGIN may list several sites, comma-separated
// (e.g. http://localhost:3000,https://crm.thefither.com).
const CORS_ORIGINS = String(process.env.CORS_ORIGIN || "http://localhost:3000")
  .split(",").map((s) => s.trim()).filter(Boolean);

app.use(
  cors({
    origin: CORS_ORIGINS,
    credentials: true,
  })
);

// ── Webhook routes need RAW body for HMAC signature verification ──
// MUST be registered BEFORE express.json(). Otherwise express.json
// consumes the body and the signature verifier receives a parsed
// object instead of bytes → "data argument must be Buffer" crash.
app.use("/api/webhooks/meta",        express.raw({ type: "application/json" }));
app.use("/api/webhooks/app/event",   express.raw({ type: "application/json" }));
app.use("/api/webhooks/app/user-signup",   express.raw({ type: "application/json" }));
app.use("/api/webhooks/app/subscription",  express.raw({ type: "application/json" }));
app.use("/api/webhooks/app/payment",       express.raw({ type: "application/json" }));
app.use("/api/webhooks/app/engagement",    express.raw({ type: "application/json" }));
// App backend read API: raw body so verifyAppRead can check the HMAC.
app.use("/api/app/lead-info-bulk",          express.raw({ type: "application/json" }));
app.use("/api/app/fiza",                    express.raw({ type: "application/json" })); // signed by partner_backend

app.use(express.json());
app.use(cookieParser());

/*******************************
 * HEALTH CHECK — Phase 1 testable outcome
 *******************************/
app.get("/api/health", async (req, res) => {
  try {
    await sequelize.authenticate();

    // Check Baileys integration status from DB
    const integration = await Integration.findOne({ where: { name: "baileys_wa" } });

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      database: "connected",
      whatsapp: integration?.status || "unknown",
      uptime: Math.floor(process.uptime()) + "s",
    });
  } catch (err) {
    console.error("❌ Health check failed:", err.message);
    res.status(503).json({
      status: "error",
      database: "disconnected",
    });
  }
});

/*******************************
 * API ROUTES
 *******************************/
app.use("/api/leads",       leadRoutes);    // /api/leads/* (existing frontend compat)
// Country-filtered plans for the magic link modal — must come AFTER leadRoutes
// so the parent /api/leads namespace exists; this mounts sub-paths under it.
app.use("/api/leads",       plansRoutes);   // /api/leads/:leadId/available-plans
app.use("/api/leads",       require("./routes/trialLink.routes")); // trial link proxy
app.use("/api/leads",       require("./routes/paymentLink.routes")); // payment link via partner_backend (signed)
// Multi-country payment accounts — admin CRUD + rep-facing list per lead
app.use("/api",             paymentAccountsRoutes); // /api/admin/payment-accounts/*, /api/leads/:id/payment-accounts
app.use("/api/auth",        authRoutes);    // /api/auth/login
app.use("/api/admin",       authRoutes);    // /api/admin/login (existing compat)
app.use("/api/admin",       adminRoutes);
app.use("/api/admin",       require("./routes/adminLeads.routes")); // admin Leads page: search + filters
app.use("/api/admin",       require("./routes/adminOverview.routes")); // admin Dashboard: KPIs, rep workload, rep x campaign
app.use("/api/admin",       require("./routes/numberHealth.routes")); // each WhatsApp number: progress + health
app.use("/api/push-tokens",  pushTokenRoutes);
app.use("/api/automation",   automationRoutes);  // Phase 2
app.use("/api/ai",           aiRoutes);          // Phase 3 — AI agent (Fiza)
app.use("/api",              metaRoutes);        // Phase 4 — /api/webhooks/meta + /api/meta/*
app.use("/api",              campaignRoutes);    // Phase 5 — /api/campaigns + /api/wa-groups + /api/dnc
app.use("/api",              autoCampaignRoutes); // Auto campaign rules CRUD
app.use("/api",              autoTakeoverRoutes);  // Fiza auto-takeover CRUD
app.use("/api",              automationMetrics);   // Automation metrics
app.use("/api",              appRoutes);         // Phase 6 — /api/webhooks/app/* + /api/app-events
app.use("/api/app/fiza",      require("./routes/fizaChat.routes")); // Fiza in the app / web chat (signed)
app.use("/api/app",           appReadRoutes);     // CRM → App: lead-info, bulk
app.use("/api/layer-system", layerSystemRoutes); // Phase 8 — intent + funnel + override
app.use("/api/rep-quality",  repQualityRoutes);  // Phase 9 — sales rep scorecard
app.use("/api/ai-learning",  aiLearningRoutes);  // Phase 11 — Fiza learning loop
app.use("/api/ai-usage",     aiUsageRoutes);     // Phase 12 — token & cost analytics
app.use("/api/search",       searchRoutes);      // Phase 13 — universal search
app.use("/api/welcome-assets", welcomeAssetsRoutes); // Phase 15a — voice + poster admin uploads
app.use("/api/messaging-analytics", messagingAnalyticsRoutes);
app.use("/api/identity",       require("./routes/identity.routes"));       // one woman = one lead: report, phone fix, match suggestions
app.use("/api/support-tickets", require("./routes/supportTickets.routes"));
app.use("/api/rep",          require("./routes/repCampaigns.routes"));   // rep's Campaigns tab: her women per campaign // app tickets for reps (via partner_backend)
app.use("/api/tasks",          require("./routes/tasks.routes")); // owner rule: rep tasks // reactive vs proactive + send-gate health
app.use("/api/dev",          devSimulateRoutes); // Phase 16 — fake inbound for QA (guarded by ENABLE_DEV_SIMULATE)
app.use("/api",              numberUploadRoutes);  // Number upload & management
app.use("/api/admin/fizza-chats", fizzaChatsRoutes); // Phase 21 — Fizza Chats
app.use(require("./routes/health.routes"));          // /health + /api/admin/health

/*******************************
 * AUDIO STREAMING (range requests for voice notes)
 * — unchanged from original —
 *******************************/
const uploadDir = path.join(__dirname, "..", "uploads");
if (!fsSync.existsSync(uploadDir)) {
  fsSync.mkdirSync(uploadDir, { recursive: true });
}

const uploadDirResolved = path.resolve(uploadDir);

// Signed / token-checked access to every /uploads file (src/utils/mediaUrl.js).
// Log-only until UPLOADS_ACCESS=signed.
app.use("/uploads", require("./utils/mediaUrl").uploadsGuard);
app.use(require("./routes/media.routes"));   // GET /api/media-token

app.get("/uploads/:filename", (req, res, next) => {
  // Path-traversal guard: Express decodes %2F in params, so strip any
  // directory parts and make sure the final path stays inside uploads/.
  const safeName = path.basename(String(req.params.filename || ""));
  const filePath = path.resolve(uploadDirResolved, safeName);
  if (safeName !== req.params.filename || !filePath.startsWith(uploadDirResolved + path.sep)) {
    return res.status(404).json({ error: "File not found" });
  }
  const ext = path.extname(filePath).toLowerCase();
  const audioExts = [".ogg", ".opus", ".mp3", ".aac", ".wav"];
  if (!audioExts.includes(ext)) return next();

  if (!fsSync.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const stat      = fsSync.statSync(filePath);
  const fileSize  = stat.size;

  let contentType = "audio/ogg; codecs=opus";
  if (ext === ".mp3") contentType = "audio/mpeg";
  else if (ext === ".aac") contentType = "audio/aac";
  else if (ext === ".wav") contentType = "audio/wav";

  const range = req.headers.range;
  if (range) {
    const parts  = range.replace(/bytes=/, "").split("-");
    const start  = parseInt(parts[0], 10);
    const end    = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Range":  `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges":  "bytes",
      "Content-Length": chunkSize,
      "Content-Type":   contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control":  "no-store",
    });
    fsSync.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type":   contentType,
      "Accept-Ranges":  "bytes",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control":  "no-store",
    });
    fsSync.createReadStream(filePath).pipe(res);
  }
});

// Extension-tolerant fallback: if /uploads/<name> has no matching file but
// /uploads/<name>.<img-ext> exists, rewrite to it. Handles media_url values
// that were saved/typed without an extension (e.g. a campaign poster URL),
// which otherwise make WhatsApp report "Failed to fetch stream".
app.use("/uploads", (req, res, next) => {
  try {
    const rel = decodeURIComponent(req.path.replace(/^\/+/, ""));
    if (rel && !rel.includes("/") && !path.extname(rel)) {
      for (const e of [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4"]) {
        if (fsSync.existsSync(path.join(uploadDir, rel + e))) {
          req.url = "/" + rel + e;
          break;
        }
      }
    }
  } catch (_) { /* fall through to static */ }
  next();
});

// Extensions the browser may render inline. Everything else (html, svg, js,
// extensionless files, …) is forced to download so an uploaded file can never
// execute as a page on this origin. <img>/<video>/<audio> embeds ignore
// Content-Disposition, so dashboard previews keep working.
const INLINE_UPLOAD_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp",
  ".mp4", ".webm", ".mov", ".3gp", ".m4v",
  ".mp3", ".ogg", ".opus", ".aac", ".wav", ".m4a", ".oga",
  ".pdf",
]);

app.use("/uploads", express.static("uploads", {
  setHeaders: (res, filePath) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!INLINE_UPLOAD_EXTS.has(path.extname(filePath).toLowerCase())) {
      res.setHeader("Content-Disposition", "attachment");
    }
  },
}));

/*******************************
 * TEST PUSH ENDPOINTS (dev only)
 *******************************/
// Hidden (404) unless ENABLE_DEV_SIMULATE=true, and admin-only.
function devFlagOr404(req, res, next) {
  if (process.env.ENABLE_DEV_SIMULATE !== "true") return res.status(404).json({ error: "Not found" });
  next();
}

app.get("/test-push", devFlagOr404, auth, adminOnly, async (req, res) => {
  try {
    const { sendPushToSalesRep } = require("./services/notificationService");
    const repId = parseInt(req.query.repId) || 2;
    const title = req.query.title || "Test Notification";
    const body  = req.query.body  || "Push system is working 🎉";

    const rep = await SalesRep.findByPk(repId);
    if (!rep) return res.status(404).json({ error: "Sales rep not found", repId });

    const tokens = await SalesRepPushToken.findAll({ where: { sales_rep_id: repId } });
    if (tokens.length === 0) {
      return res.status(400).json({ error: "No push tokens for this rep", repId });
    }

    await sendPushToSalesRep(repId, title, body);
    res.json({ success: true, repId, title, body, tokensCount: tokens.length });
  } catch (err) {
    console.error("❌ Test push error:", err);
    res.status(500).json({ error: "Failed to send push" });
  }
});

/*******************************
 * AUTH REFRESH + CHECK
 * — unchanged from original —
 *******************************/
app.post("/auth/refresh", async (req, res) => {
  const refreshToken = req.cookies.refresh_token;
  if (!refreshToken) return res.status(401).json({ message: "No refresh token" });
  try {
    const payload = jwt.verify(refreshToken, process.env.REFRESH_SECRET);
    const rep = await SalesRep.findByPk(payload.repId);
    if (!rep) return res.status(404).json({ message: "User not found" });
    if (rep.status !== "active") return res.status(403).json({ message: "Account is inactive" });

    const token = jwt.sign(
      { repId: rep.id, whatsappAccountId: rep.whatsapp_account_id, role: rep.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );
    res.json({ token, rep: { id: rep.id, name: rep.name, email: rep.email, role: rep.role } });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(403).json({ message: "Invalid or expired refresh token" });
    }
    console.error("❌ Refresh token error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/auth/check", async (req, res) => {
  const refreshToken = req.cookies.refresh_token;
  if (!refreshToken) return res.status(401).json({ loggedIn: false, message: "No refresh token" });
  try {
    const payload = jwt.verify(refreshToken, process.env.REFRESH_SECRET);
    const rep = await SalesRep.findByPk(payload.repId);
    if (!rep) return res.status(404).json({ loggedIn: false, message: "User not found" });
    if (rep.status !== "active") return res.status(403).json({ loggedIn: false, message: "Account is inactive" });
    res.json({ loggedIn: true, rep: { id: rep.id, name: rep.name, email: rep.email, role: rep.role } });
  } catch (err) {
    return res.status(401).json({ loggedIn: false, message: "Invalid or expired token" });
  }
});

/*******************************
 * GLOBAL ERROR HANDLER (must be the last middleware)
 *******************************/
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    console.warn("⚠️  Upload rejected:", req.method, req.originalUrl, err.code);
    return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "File too large" : "Invalid upload" });
  }

  const status = err.status || err.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    // Client errors (bad JSON body, payload too large, upload validation…)
    return res.status(status).json({ error: err.publicMessage || http.STATUS_CODES[status] || "Bad request" });
  }

  console.error("❌ Unhandled error:", req.method, req.originalUrl, err);
  res.status(500).json({ error: "Internal server error" });
});

/*******************************
 * HTTP SERVER + SOCKET.IO
 * — zero changes to socket logic —
 *******************************/
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ["GET", "POST"],
  },
});

/*******************************
 * SOCKET AUTH MIDDLEWARE
 *******************************/
// Dual-source socket auth — accepts both CRM-issued JWTs (admin path) and
// partner_backend-issued JWTs (sales rep path). Same fallback logic as the
// HTTP middleware at src/middleware/auth.middleware.js.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      console.log("❌ Socket rejected: No token");
      return next(new Error("Unauthorized"));
    }

    // Path 1: CRM-native JWT (admin)
    let crmDecoded = null;
    try {
      crmDecoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    } catch { /* fall through to partner path */ }
    if (crmDecoded?.repId) {
      // Load the rep: reject deactivated reps and take the role from the DB,
      // not from the token.
      const rep = await SalesRep.findByPk(crmDecoded.repId);
      if (!rep || rep.status !== "active") {
        console.log(`❌ Socket rejected: rep ${crmDecoded.repId} missing or inactive`);
        return next(new Error("Unauthorized"));
      }
      socket.repId             = crmDecoded.repId;
      socket.whatsappAccountId = crmDecoded.whatsappAccountId;
      socket.role              = rep.role || "rep";
      console.log("🔐 Socket authenticated (CRM):", socket.repId);
      return next();
    }

    // Path 2: partner_backend JWT (sales rep)
    // Same rules as HTTP: staff portal tokens only, must expire.
    const partnerCheck = require("./middleware/auth.middleware").verifyPartnerToken(token);
    if (partnerCheck.reason && partnerCheck.reason !== "invalid" && partnerCheck.reason !== "not_configured") {
      console.log(`❌ Socket rejected: partner token ${partnerCheck.reason}`);
      return next(new Error("Unauthorized"));
    }
    if (partnerCheck.payload) {
      try {
        const partnerDecoded = partnerCheck.payload;
        if (partnerDecoded?.id) {
          const rep = await SalesRep.findOne({
            where: { partner_user_id: partnerDecoded.id },
          });
          if (!rep) {
            console.log(`❌ Socket rejected: partner_user_id=${partnerDecoded.id} not provisioned in CRM`);
            return next(new Error("Account not provisioned for CRM"));
          }
          if (rep.status !== "active") {
            console.log(`❌ Socket rejected: rep ${rep.id} is inactive`);
            return next(new Error("Unauthorized"));
          }
          socket.repId             = rep.id;
          socket.whatsappAccountId = rep.whatsapp_account_id;
          socket.role              = rep.role || "rep";
          console.log("🔐 Socket authenticated (partner):", socket.repId);
          return next();
        }
      } catch { /* fall through to final reject */ }
    }

    console.log("❌ Socket auth failed: token not valid under either secret");
    return next(new Error("Unauthorized"));
  } catch (err) {
    console.log("❌ Socket auth failed:", err.message);
    next(new Error("Unauthorized"));
  }
});

/*******************************
 * SOCKET EVENTS
 * SOCKET vs FIREBASE PUSH FLOW:
 * - In onlineUsers → use SOCKET (no push).
 * - Not in onlineUsers → use FIREBASE push.
 * - background: tab minimized → remove from onlineUsers, mark repInBackground → Firebase.
 * - foreground: tab restored → add to onlineUsers, clear repInBackground → socket.
 * - disconnect: tab/browser closed → remove from onlineUsers → Firebase.
 *******************************/
const repSession = require("./services/repSession.service");

io.on("connection", (socket) => {
  console.log("🟢 Socket connected:", socket.id);
  console.log("👤 Rep:", socket.repId);
  console.log("📱 WhatsAppAccount:", socket.whatsappAccountId);

  // New connection = foreground
  if (socket.repId) {
    repInBackground.delete(socket.repId);
    onlineUsers[socket.repId] = socket;
    console.log(`✅ [Rep ${socket.repId}] FOREGROUND → using SOCKET (push disabled)`);
    // Phase 9 — open/refresh rep_session row
    repSession.onSocketConnect(socket.repId).catch(e =>
      console.error("[RepSession] connect hook failed:", e.message));
  }

  socket.join(`rep_${socket.repId}`);
  console.log(`🧑‍💼 Joined room: rep_${socket.repId}`);

  // Admin-only room (WhatsApp QR / pairing-code events are emitted here).
  if (socket.role === "admin") {
    socket.join("admins");
    console.log(`🛡️  Joined room: admins (rep ${socket.repId})`);
  }

  // Only admins or the lead's assigned rep may subscribe to a lead room.
  socket.on("joinLead", async (leadId) => {
    try {
      const id = Number(leadId);
      if (!Number.isInteger(id) || id <= 0) return;
      if (socket.role !== "admin") {
        const lead = await People.findByPk(id, { attributes: ["id", "assigned_to"] });
        if (!lead || Number(lead.assigned_to) !== Number(socket.repId)) {
          console.log(`🚫 [Rep ${socket.repId}] joinLead denied for lead_${id}`);
          return;
        }
      }
      socket.join(`lead_${id}`);
      console.log(`📥 Joined lead room: lead_${id}`);
    } catch (err) {
      console.error("❌ joinLead error:", err.message);
    }
  });

  // Tab minimized → use Firebase
  socket.on("background", () => {
    if (socket.repId) {
      repInBackground.add(socket.repId);
      delete onlineUsers[socket.repId];
      console.log(`📴 [Rep ${socket.repId}] BACKGROUND → using FIREBASE`);
      repSession.onSocketBackground(socket.repId).catch(() => {});
    }
  });

  // Phase 9 — UI activity ping keeps session in 'active' state
  socket.on("activity", () => {
    if (socket.repId) repSession.bumpHeartbeat(socket.repId);
  });

  // Tab visible again → use socket + refresh people list
  socket.on("foreground", async () => {
    if (socket.repId) {
      repInBackground.delete(socket.repId);
      onlineUsers[socket.repId] = socket;
      console.log(`🟢 [Rep ${socket.repId}] FOREGROUND → using SOCKET again`);
      repSession.onSocketForeground(socket.repId).catch(() => {});

      try {
        const people = await People.findAll({
          where: {
            assigned_to:          socket.repId,
            whatsapp_account_id:  socket.whatsappAccountId,
          },
          order: [["last_message_at", "DESC"]],
        });
        socket.emit("refreshLeads", people);
        console.log(`📋 [Rep ${socket.repId}] Sent refreshLeads (${people.length} people)`);
      } catch (err) {
        console.error(`❌ [Rep ${socket.repId}] Failed to send refreshLeads:`, err.message);
      }
    }
  });

  // Disconnected → Firebase from now on
  socket.on("disconnect", () => {
    console.log("🔴 Socket disconnected:", socket.id);
    if (socket.repId) {
      repInBackground.delete(socket.repId);
      delete onlineUsers[socket.repId];
      console.log(`❌ [Rep ${socket.repId}] DISCONNECTED → using FIREBASE`);
      repSession.onSocketDisconnect(socket.repId).catch(() => {});
    }
  });
});

/*******************************
 * MAKE IO AVAILABLE EVERYWHERE
 *******************************/
app.set("io", io);

/*******************************
 * START SERVER
 *******************************/
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 FitHer CRM backend running on port: ${PORT}`);
});

/*******************************
 * DATABASE INIT
 *******************************/
(async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Database connected!");

    // Sync only new Phase 1 tables (safe — alter:false won't drop columns)
    // New tables: activities, events, integrations
    // Existing tables: use migration SQL instead of sync to avoid column drops
    const { Activity, Event, Integration } = require("../models");
    await Activity.sync({ alter: false });
    await Event.sync({ alter: false });
    await Integration.sync({ alter: false });

    console.log("✅ Phase 1 tables ready!");

    // Phase 2 — sync new tables
    const { AutomationRule, AutomationLog, MessageTemplate } = require("../models");
    await AutomationRule.sync({ alter: false });
    await AutomationLog.sync({ alter: false });
    await MessageTemplate.sync({ alter: false });
    console.log("✅ Phase 2 tables ready!");

    await ensureAssignmentState();

    // Start automation engine + cron jobs
    startWorker();
    // inactivityJob is OFF (9 Nov 2026): it re-fired inactivity_24h every
    // hour for every quiet lead, duplicated the follow-up engine (which owns
    // lead nurturing), and judged app customers "inactive" by WhatsApp
    // silence. App activity now comes from the app (daily snapshot).
    // startInactivityJob();
    // Database-only jobs: here when CRM_PROCESS is "all", otherwise in
    // src/worker.js. (Each job is locked, so both running is still safe.)
    if (RUN_DB_JOBS) {
      startChurnJob();
      // Owner rule (9 Nov 2026): push reps when their tasks are due, move
      // tasks off deactivated reps. See src/services/owner.service.js.
      require("./services/owner.service").startOwnerJob();
      require("./broadcast/campaignWeightsJob").startCampaignWeightsJob();
      require("./jobs/repDailySnapshot.job").startDailySnapshotJob();
      require("./jobs/repQualityRules.job").startRepQualityJob();
      require("./jobs/planSync.job").startPlanSyncJob();
    }

    // Phase 5 — broadcast worker for marketing campaigns
    const { startBroadcastWorker } = require("./broadcast/broadcastWorker");
    startBroadcastWorker();

    // (Phase 19d campaign weights job: started with the database-only jobs above.)

    // Auto campaign engine (trigger-based rules)
    const { startAutoCampaignJob } = require("./services/autoCampaign.service");
    startAutoCampaignJob();

    // Fiza auto-takeover engine
    const { startAutoTakeoverJob } = require("./services/autoTakeover.service");
    startAutoTakeoverJob();

    // Phase 8 — Layer 5 follow-up engine
    const { startFollowupEngine } = require("./jobs/followupEngine");
    startFollowupEngine(io);

    // Phase 9 — rep session heartbeat (reads this process's socket state, so
    // it always runs here). Daily snapshot + quality rules: database-only
    // jobs above.
    const { startSessionHeartbeat } = require("./services/repSession.service");
    startSessionHeartbeat();
  } catch (err) {
    console.error("❌ Database error:", err);
  }
})();

/*******************************
 * WHATSAPP (BAILEYS) INIT
 * — zero changes to Baileys flow —
 *******************************/
(async () => {
  try {
    const accounts = await WhatsAppAccount.findAll({ where: { status: "active" } });

    // One failing account must not stop the others from booting.
    for (const acc of accounts) {
      try {
        await createBaileysClient(acc.id, io);
      } catch (err) {
        console.error(`❌ WhatsApp init failed for account ${acc.id}:`, err);
      }
    }

    console.log("📲 Baileys WhatsApp clients initialized");

    // Mark Baileys integration as active in integrations table
    await Integration.update(
      { status: "active", last_ping_at: new Date() },
      { where: { name: "baileys_wa" } }
    );
  } catch (err) {
    console.error("❌ WhatsApp init error:", err);
  }
})();

/*******************************
 * BAILEYS HEALTH-CHECK CRON
 * Pings integration status every 60s
 *******************************/
setInterval(require("./monitor/jobs").wrap("whatsapp-health", async () => {
  try {
    const { isAccountConnected } = require("./whatsapp/baileysClient");
    const accounts = await WhatsAppAccount.findAll({ where: { status: "active" } });

    // Per-account connection map (the old code overwrote a single shared row in
    // a loop, so the integration status only ever reflected the LAST account).
    const perAccount = accounts.map((acc) => ({
      id: acc.id,
      phone_number: acc.phone_number,
      connected: isAccountConnected(acc.id),
    }));
    const connectedCount = perAccount.filter((a) => a.connected).length;

    // Aggregate status: active only if every active account has a live socket.
    const status =
      accounts.length === 0
        ? "disconnected"
        : connectedCount === accounts.length
        ? "active"
        : connectedCount === 0
        ? "disconnected"
        : "error"; // partial outage — at least one number is down

    await Integration.update(
      {
        status,
        last_ping_at: new Date(),
        config: { total: accounts.length, connected: connectedCount, accounts: perAccount },
      },
      { where: { name: "baileys_wa" } }
    );
  } catch (err) {
    // Never crash the server over a health-check failure
    console.error("❌ Health-check cron error:", err.message);
  }
}, { lock: false }), 60 * 1000);
