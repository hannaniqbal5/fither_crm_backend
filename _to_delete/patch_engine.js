const fs=require("fs");const p=process.argv[2]+"/src/jobs/followupEngine.js";let s=fs.readFileSync(p,"utf8");
function rep(a,b){ if(!s.includes(a)) throw new Error("nf: "+a.slice(0,70)); s=s.replace(a,b); }

rep(`const { keyFor, TEMPLATES, pickVariant, renderTemplate } = require("../ai/followupTemplates");`,
`const { keyFor, TEMPLATES, pickVariant, renderTemplate, stepsFor } = require("../ai/followupTemplates");`);

// helpers
rep(`async function logFollowup(row) {`, `// Nov 2026 sequences: where is this lead in her follow-up sequence?
// Counted from HER last message — a reply from her starts a new sequence.
async function sequenceState(person) {
  const [[r]] = await sequelize.query(
    "SELECT MAX(created_at) AS t FROM messages WHERE lead_id = :id AND direction = 'IN'",
    { replacements: { id: person.id } }
  );
  const lastInboundAt = (r && r.t) ? new Date(r.t) : new Date(person.created_at || person.last_message_at || Date.now());
  const [[d]] = await sequelize.query(
    \`SELECT COUNT(*) AS c FROM \${FOLLOWUP_LOG_TABLE}
       WHERE lead_id = :id AND status IN ('sent','drafted') AND fired_at > :since\`,
    { replacements: { id: person.id, since: lastInboundAt } }
  );
  // A follow-up draft the rep hasn't decided on yet → don't stack another.
  const [[p]] = await sequelize.query(
    "SELECT COUNT(*) AS c FROM ai_replies WHERE lead_id = :id AND status = 'draft' AND user_message LIKE '[layer5_followup:%'",
    { replacements: { id: person.id } }
  );
  return { lastInboundAt, stepsDone: Number(d.c || 0), pendingDraft: Number(p.c || 0) > 0 };
}

async function logFollowup(row) {`);

// candidate cutoff: first step of each status
rep(`    if (t.silence_hours < 0) continue; // -1 = reminder-to-rep templates
    triggers.push({ key, ...t });`, `    const steps = stepsFor(key);
    if (!steps.length) continue; // no follow-ups for this status (e.g. rep reminders)
    triggers.push({ key, ...t, silence_hours: steps[0] });`);

// per-person sequence gate, right after tplDef
rep(`      const tplDef = TEMPLATES[templateKey];
`, `      const tplDef = TEMPLATES[templateKey];

      // Sequence: which step is due, if any.
      const steps = stepsFor(templateKey);
      const seq = await sequenceState(person);
      if (seq.pendingDraft) continue;                 // rep hasn't decided the last one
      if (seq.stepsDone >= steps.length) continue;    // sequence finished — wait for her
      const hoursSilent = (Date.now() - seq.lastInboundAt.getTime()) / TIME_UNIT_MS;
      if (hoursSilent < steps[seq.stepsDone]) continue; // next step not due yet
`);

// render: Fiza writes it
rep(`      // Render message
      const raw = pickVariant(templateKey, fired);
      const rendered = renderTemplate(raw, person);`, `      // Fiza writes the follow-up from the real chat; the template is only a
      // fallback (and then only as a rep draft, never auto-sent).
      const { writeFollowup } = require("../ai/followupWriter");
      const written = await writeFollowup(person, templateKey, {
        stepIndex: seq.stepsDone, totalSteps: steps.length, hoursSilent,
      });
      const rendered = written || renderTemplate(pickVariant(templateKey, fired), person);`);

rep(`        (FAST_MODE || !isWorkHrs); // off-hours only per spec; FAST_MODE bypasses`,
`        (FAST_MODE || !isWorkHrs) && // off-hours only per spec; FAST_MODE bypasses
        !!written; // a fallback template is never auto-sent`);
fs.writeFileSync(p,s);console.log("ok");
