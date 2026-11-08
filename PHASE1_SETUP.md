# Phase 1 Setup — FitHer CRM

## What changed (Lead → People)

All code now uses `People` instead of `Lead`. The **database table stays `leads`** — zero data loss, no table rename. The Sequelize model just points to `tableName: "leads"` internally.

| Old | New |
|---|---|
| `models/Lead.js` | `models/People.js` |
| `const { Lead }` | `const { People }` — `Lead` still exported as alias |
| `lead.stage` missing | `people.stage` = `visitor\|lead\|user\|churned` |
| no `lead_score` | `people.lead_score` — incremented on every activity |
| no `activities` table | logs every WhatsApp message + future events |
| no `events` table | automation engine queue (Phase 2 uses this) |
| no `integrations` table | tracks Baileys connection health |

## Step 1 — Run the migration

```bash
mysql -u root -p crm < migrations/001_phase1_foundation.sql
```

Verify:
```sql
SHOW COLUMNS FROM leads;     -- should show stage, language, lead_score, etc.
SHOW TABLES;                 -- should show activities, events, integrations
SELECT * FROM integrations;  -- should show baileys_wa row
```

## Step 2 — Install new dependency

```bash
npm install uuid
```

## Step 3 — Start locally

```bash
npm run dev
```

## Step 4 — Phase 1 testable outcome (from blueprint)

Send a WhatsApp message to the business number. Then verify in DB:

```sql
-- 1. Person row created (dedup by phone)
SELECT id, phone, stage, lead_score, last_activity_at FROM leads ORDER BY created_at DESC LIMIT 5;

-- 2. Message row logged
SELECT id, lead_id, direction, message_type, created_at FROM messages ORDER BY created_at DESC LIMIT 5;

-- 3. Activity row written (message_received)
SELECT * FROM activities ORDER BY created_at DESC LIMIT 5;

-- 4. Event fired (lead_created + conversation_started)
SELECT * FROM events ORDER BY created_at DESC LIMIT 5;
```

Also hit the health endpoint:
```
GET http://localhost:4000/api/health
```
Should return `{"status":"ok","database":"connected",...}`

## New API endpoints added in Phase 1

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check — DB + Baileys status |
| `GET` | `/api/people` | Same as `/api/leads` — new CRM naming |
| `GET` | `/api/people/:id` | Same as `/api/leads/:id` |
| `PATCH` | `/api/leads/:id/stage` | Update CRM stage (visitor/lead/user/churned) |
| `PATCH` | `/api/leads/:id/language` | Set language (en/ur) for bilingual automation |
| `PATCH` | `/api/leads/:id/notes` | Save agent notes |
| `GET` | `/api/admin/people/:id/timeline` | Activity log for a person |
| `GET` | `/api/admin/people/:id/events` | Events queue for a person |
| `PATCH` | `/api/admin/people/:id/stage` | Admin: update stage + fire churn event |
| `GET` | `/api/admin/integrations` | Integration health status |

## What was NOT changed (working perfectly)

- `src/whatsapp/baileysClient.js` — Baileys connection, QR, reconnect, media download
- `socket/repState.js` — online/background tracking
- `socket/onlineUsers.js`
- `src/middleware/auth.middleware.js`
- `src/services/notificationService.js` — Firebase push
- `src/services/assignment.service.js` — round-robin
- `src/config/firebase.js`
- `script/createSalesrep.js`
- `script/createWhatsAppAccount.js`

## Phase 2 preview

When you're ready, Phase 2 adds:
- `automation_rules` table
- `automation_logs` table
- `message_templates` table (bilingual en/ur)
- Worker that polls `events WHERE processed = 0` every 30s
- Inactivity cron (24h + 7d)
- Churn detection cron
