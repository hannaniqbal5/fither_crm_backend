# Phase 2 Setup — Automation Engine

## What was added

### New files
```
models/
├── AutomationRule.js    ← rules admin creates
├── AutomationLog.js     ← every engine execution logged here
└── MessageTemplate.js   ← bilingual message templates

src/
├── engine/
│   ├── worker.js        ← 30s polling loop
│   ├── evaluator.js     ← checks rule conditions against person
│   └── executor.js      ← runs rule actions
├── channels/
│   ├── channelRouter.js     ← routes to correct channel adapter
│   ├── whatsappChannel.js   ← wraps baileysClient (zero Baileys changes)
│   └── instagramChannel.js  ← stub, ready for Phase 5
├── services/
│   └── template.service.js  ← bilingual resolver + placeholder filler
├── jobs/
│   ├── inactivityJob.js     ← hourly cron (24h + 7d inactivity)
│   └── churnJob.js          ← daily 02:00 cron (payment_failed_3x)
└── routes/
    └── automation.routes.js ← admin CRUD for rules, templates, logs

migrations/
└── 002_phase2_automation.sql ← 3 new tables + seed data
```

### Zero changes to
- `baileysClient.js` — Baileys untouched
- `message.handler.js` — untouched
- Socket/push system — untouched
- All existing routes — untouched

---

## Step 1 — Run Phase 2 migration

```bash
mysql -u root -p crmm < migrations/002_phase2_automation.sql
```

Verify:
```sql
SHOW TABLES;
SELECT name, trigger_event, channel FROM automation_rules;
SELECT name, channel, language FROM message_templates ORDER BY name;
```

---

## Step 2 — Install new dependency

```bash
npm install
```

(adds `node-cron`)

---

## Step 3 — Start server

```bash
npm run dev
```

You should see in the terminal:
```
🚀 [Worker] Automation engine started — polling every 30s
⏰ [InactivityJob] Scheduled — runs every hour
💔 [ChurnJob] Scheduled — runs daily at 02:00
✅ Phase 2 tables ready!
```

---

## Step 4 — Test the engine locally

### Quick test (2-minute inactivity)

Add to your `.env`:
```
INACTIVITY_24H_MINUTES=2
```

1. Send a WhatsApp message to the business number (creates lead + fires `lead_created` event)
2. Wait 2 minutes (inactivity job fires `inactivity_24h` event)
3. Engine picks it up in next 30s poll
4. Auto follow-up WhatsApp arrives on the sender's phone

Check the logs:
```sql
SELECT al.channel, al.status, al.executed_at, ar.name as rule_name
FROM automation_logs al
JOIN automation_rules ar ON al.rule_id = ar.rule_id
ORDER BY al.executed_at DESC LIMIT 10;
```

---

## New API Endpoints (Phase 2)

All require `Authorization: Bearer <token>` + `role = admin`

### Rules
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | /api/automation/rules | List all rules |
| POST   | /api/automation/rules | Create rule |
| PUT    | /api/automation/rules/:id | Update rule |
| PATCH  | /api/automation/rules/:id/toggle | Enable/disable |
| DELETE | /api/automation/rules/:id | Delete rule |

### Templates
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | /api/automation/templates | List (filter by ?channel=whatsapp&language=ur) |
| POST   | /api/automation/templates | Create template |
| PUT    | /api/automation/templates/:id | Update template |
| DELETE | /api/automation/templates/:id | Delete template |

### Logs
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | /api/automation/logs | List logs (filter by ?channel=whatsapp&status=success) |
| GET    | /api/automation/logs/by-channel | Stats grouped by channel |

---

## Channel Architecture

```
engine → executor → channelRouter → whatsappChannel  ✅ live
                                 → instagramChannel  ⏳ Phase 5 stub
                                 → emailChannel      🔮 future
```

Every automation log records which `channel` was used.
Frontend can filter logs by channel — shows WhatsApp vs Instagram sections separately.

### Adding a new channel (Phase 5 example)
1. Create `src/channels/instagramChannel.js` with real Meta Graph API code
2. That's it. channelRouter already routes there. Engine, executor, evaluator — zero changes.

---

## Rule JSON format

```json
{
  "name": "24h Follow-up (Urdu WhatsApp)",
  "trigger_event": "inactivity_24h",
  "conditions": {
    "stage": "lead",
    "language": "ur",
    "source": "whatsapp"
  },
  "actions": [
    {
      "type": "send_message",
      "template": "followup_1_ur",
      "channel": "whatsapp"
    }
  ],
  "channel": "whatsapp",
  "delay_minutes": 0,
  "run_once_per_person": false
}
```

### Supported trigger events
`lead_created` · `conversation_started` · `inactivity_24h` · `inactivity_7d` · `churn_detected` · `payment_success` · `payment_failed` · `subscription_started` · `workout_started` · `workout_completed`

### Supported action types
- `send_message` — sends template via channelRouter
- `update_stage` — updates person.stage (+ fires stage_changed event)
- `assign_rep` — round-robin reassign to next available rep

### Condition values
Use `"any"` as a value to match all: `{ "stage": "any", "language": "ur" }`
Use an array for multiple allowed values: `{ "stage": ["lead", "visitor"] }`
