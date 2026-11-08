/**
 * setupWinbackCampaign.js — one-shot setup for the 30% off win-back WhatsApp campaign.
 *
 * Creates:
 *   1. Two message templates (Day 0 initial + Day 2 reminder)
 *   2. A draft campaign pre-configured with the body, media, audience, and pacing
 *
 * Usage:
 *   node scripts/setupWinbackCampaign.js
 *
 * After running, log into admin → Campaigns → click "Start" on the draft.
 * If you re-run, it updates the existing rows (idempotent by name/title).
 */

require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const sequelize = require("../src/config/database");
const { MessageTemplate } = require("../models");

const MEDIA_PATH = "/uploads/fither_winback_30off.png";

const INITIAL_BODY_UR = `Assalam-o-Alaikum,

Yeh Fiza FitHer se. Aap pehle hamari member rahi hain — iss liye sirf return karne wali members ke liye hum ne ek special offer rakha hai.

Stronger Women. Healthier Lives.

3-Month Return Membership:
• Regular price: PKR 7,000 per month
• Aap ke liye: PKR 5,000 per month
• Total saving: PKR 6,000
• 30% off — sirf return members ke liye

Aap ko milega:
• Daily live sessions — Morning Yoga, Evening Zumba, High Intensity aur Low Intensity
• 9 flexible time slots (8 AM se 10 PM tak)
• Unlimited classes per day
• PCOS/PCOD specialized programs
• In-app one-on-one video consultation aur personalized diet plan
• Freezing option agar break chahiye
• 1-day 100% refund policy

Yeh offer sirf 3 din ke liye valid hai.

Reactivate karne ke liye "READY" likh kar reply karein. Main aap ka account turant set kar dungi.

Shukriya,
Fiza
FitHer Team`;

const REMINDER_BODY_UR = `Assalam-o-Alaikum,

A short reminder — your FitHer return offer (PKR 5,000/month for 3 months, 30% off) expires tomorrow.

Stronger Women. Healthier Lives.

If you'd like to reactivate, reply "READY". The next discount cycle will not be available for 6 months.

Shukriya,
Fiza
FitHer Team`;

async function upsertTemplate(name, body, mediaUrl) {
  const existing = await MessageTemplate.findOne({ where: { name } });
  if (existing) {
    await existing.update({ body, media_url: mediaUrl });
    console.log(`  Updated template: ${name}`);
    return existing;
  }
  const created = await MessageTemplate.create({
    template_id: uuidv4(),
    name,
    channel: "whatsapp",
    language: "ur",
    body,
    media_url: mediaUrl,
  });
  console.log(`  Created template: ${name}`);
  return created;
}

async function upsertCampaign(name, body, mediaUrl) {
  const [existing] = await sequelize.query(
    `SELECT campaign_id, status FROM campaigns WHERE name = :name LIMIT 1`,
    { replacements: { name } }
  );
  if (existing.length > 0) {
    const row = existing[0];
    if (row.status === "running") {
      console.log(`  Campaign "${name}" already running — leaving untouched.`);
      return row.campaign_id;
    }
    await sequelize.query(
      `UPDATE campaigns SET body = :body, media_url = :mediaUrl WHERE campaign_id = :id`,
      { replacements: { body, mediaUrl, id: row.campaign_id } }
    );
    console.log(`  Updated existing campaign: ${name}  (status: ${row.status})`);
    return row.campaign_id;
  }
  const id = uuidv4();
  await sequelize.query(
    `INSERT INTO campaigns (
       campaign_id, name, description, body, media_url, language, channel, status,
       source_type, source_meta,
       delay_min_seconds, delay_max_seconds, daily_cap,
       send_window_start, send_window_end,
       total_recipients, sent_count, replied_count, failed_count,
       created_at
     ) VALUES (
       :id, :name, :description, :body, :mediaUrl, 'ur', 'whatsapp', 'draft',
       'segment', :sourceMeta,
       8, 15, 400,
       '09:00', '21:00',
       0, 0, 0, 0,
       NOW()
     )`,
    {
      replacements: {
        id,
        name,
        description: "30% off return-member offer — sent to all churned leads",
        body,
        mediaUrl,
        sourceMeta: JSON.stringify({ stage: "churned" }),
      },
    }
  );
  console.log(`  Created draft campaign: ${name}  (id: ${id})`);
  return id;
}

async function run() {
  console.log("\n  FitHer winback campaign setup\n");

  try {
    await sequelize.authenticate();

    console.log("  Saving templates...");
    await upsertTemplate("winback_30off_initial_ur", INITIAL_BODY_UR, MEDIA_PATH);
    await upsertTemplate("winback_30off_reminder_ur", REMINDER_BODY_UR, null);

    console.log("\n  Creating draft campaigns...");
    const initialId  = await upsertCampaign("Winback 30% off — Day 0 initial", INITIAL_BODY_UR, MEDIA_PATH);
    const reminderId = await upsertCampaign("Winback 30% off — Day 2 reminder", REMINDER_BODY_UR, null);

    const [[c]] = await sequelize.query(
      `SELECT COUNT(*) AS count FROM leads WHERE stage = 'churned' AND phone IS NOT NULL`
    );

    console.log(`\n  Churned audience size:  ${c.count} leads with phone`);
    console.log(`\n  Image media:            ${MEDIA_PATH}`);
    console.log(`  Serving at:             ${process.env.BASE_URL || "http://localhost:4000"}${MEDIA_PATH}`);
    console.log("\n  Done. Next steps:");
    console.log("    1. Log into the admin panel as admin");
    console.log("    2. Open the Campaigns tab");
    console.log("    3. You'll see two draft campaigns ready to launch");
    console.log("    4. Click 'Start' on the Day 0 campaign first");
    console.log("    5. After 48 hours, click 'Start' on the Day 2 reminder\n");

    process.exit(0);
  } catch (err) {
    console.error("\n  ERROR:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

run();
