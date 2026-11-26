/**
 * messageBatcher.service.js — one reply for one thought, as fast as possible.
 *
 * Fiza starts writing as soon as a message arrives (after MSG_BATCH_DEBOUNCE_MS,
 * which can be 0). If the woman sends another message while Fiza is still
 * writing, that reply is dropped and Fiza starts again with ALL the messages
 * she hasn't answered yet — so she still gets one reply for the full thought,
 * and the usual single message is answered without any waiting.
 *
 *   1. Inbound arrives → added to this lead's unanswered list; any reply in
 *      progress becomes stale (its token no longer matches).
 *   2. After the debounce (default 0 ms) → callback(combinedText, ids, meta).
 *   3. The callback MUST check meta.isCurrent() before sending: false means a
 *      newer message arrived (or a rep took over via cancel()) — drop the reply.
 *   4. A current reply that finishes clears the list.
 *
 * Cost: one extra AI call each time she adds a message mid-reply.
 * Safety: at most MAX_QUEUE_PER_LEAD messages are combined; a callback error
 * never poisons the list; a list untouched for STALE_MS is dropped.
 */

const DEBOUNCE_MS = Math.max(0, parseInt(process.env.MSG_BATCH_DEBOUNCE_MS || "0", 10) || 0);
const MAX_QUEUE_PER_LEAD = parseInt(process.env.MSG_BATCH_MAX_PER_LEAD || "5", 10);
const STALE_MS = parseInt(process.env.MSG_BATCH_INFLIGHT_STALE_MS || "180000", 10);

// leadId -> { messages: [{text,msg_id,arrived_at}], token, timer, touchedAt, callback }
const leads = new Map();

function push(leadId, msg, callback) {
  if (!leadId || !msg) return;
  let s = leads.get(leadId);
  if (s && Date.now() - s.touchedAt > STALE_MS) {
    if (s.timer) clearTimeout(s.timer);
    leads.delete(leadId);
    s = null;
  }
  if (!s) {
    s = { messages: [], token: 0, timer: null, touchedAt: Date.now(), callback };
    leads.set(leadId, s);
  }
  s.messages.push({ text: msg.text || "", msg_id: msg.msg_id || null, arrived_at: Date.now() });
  if (s.messages.length > MAX_QUEUE_PER_LEAD) s.messages = s.messages.slice(-MAX_QUEUE_PER_LEAD);
  s.callback = callback; // latest closure is freshest
  s.touchedAt = Date.now();
  s.token += 1;          // any reply already being written is now stale

  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => flush(leadId, s.token > 1 ? "restart" : "new"), DEBOUNCE_MS);
}

function flush(leadId, reason = "new") {
  const s = leads.get(leadId);
  if (!s || !s.messages.length) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;

  const myToken = s.token;
  const combined = s.messages
    .map((m) => (m.text || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const ids = s.messages.map((m) => m.msg_id).filter(Boolean);
  const count = s.messages.length;
  const isCurrent = () => leads.get(leadId) === s && s.token === myToken;

  console.log(`💬 [Batcher] Lead ${leadId} — writing reply for ${count} msg(s) (${reason}): "${combined.slice(0, 100)}${combined.length > 100 ? "…" : ""}"`);

  Promise.resolve()
    .then(() => s.callback(combined, ids, { count, reason, isCurrent }))
    .catch((err) => console.error(`[Batcher] callback error for lead ${leadId}:`, err?.message || err))
    .finally(() => {
      // Answered (or failed) and nothing newer arrived → start fresh next time.
      if (isCurrent()) leads.delete(leadId);
    });
}

/** cancel — a rep replied by hand: drop the list and any reply in progress. */
function cancel(leadId) {
  const s = leads.get(leadId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  leads.delete(leadId);
  console.log(`[Batcher] Lead ${leadId} — cancelled`);
}

function stats() {
  return {
    active_leads: leads.size,
    by_lead: Array.from(leads.entries()).map(([leadId, s]) => ({
      lead_id: leadId,
      unanswered: s.messages.length,
      waiting_ms: Date.now() - (s.messages[0]?.arrived_at || s.touchedAt),
    })),
  };
}

module.exports = { push, flush, cancel, stats, DEBOUNCE_MS };
