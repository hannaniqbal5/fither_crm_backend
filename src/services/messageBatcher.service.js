/**
 * messageBatcher.service.js — Phase 15b.
 *
 * Debounces rapid inbound messages from the same customer so Fiza generates
 * ONE intelligent reply for the full thought, not 3 fragmented replies for 3
 * quick messages.
 *
 * How it works:
 *   1. Inbound arrives → push into queue keyed by lead_id
 *   2. Start (or reset) a debounce timer (8 sec default)
 *   3. If another inbound for same lead arrives → push + reset timer
 *   4. When timer fires → concatenate all queued messages into one combined
 *      "user message" → trigger the callback ONCE with the combined text
 *
 * Safety:
 *   - Force-flush if queue grows beyond 5 messages (prevents accidental hold)
 *   - Force-flush if a single message has been waiting > 20 sec
 *   - Crash-safe: failures in the callback don't poison the queue
 */

const DEBOUNCE_MS = parseInt(process.env.MSG_BATCH_DEBOUNCE_MS || "8000", 10);
const MAX_QUEUE_PER_LEAD = parseInt(process.env.MSG_BATCH_MAX_PER_LEAD || "5", 10);
const MAX_WAIT_MS = parseInt(process.env.MSG_BATCH_MAX_WAIT_MS || "20000", 10);

// leadId -> { messages: [{ text, msg_id, arrived_at }], timer, firstArrivedAt, callback }
const queues = new Map();

// Per-lead in-flight lock: leadId -> startedAt. While a reply is being
// generated/sent for a lead, newly flushed batches WAIT and run once the
// current one finishes — never two parallel generations for one lead.
// A lock older than INFLIGHT_STALE_MS is treated as dead (safety valve).
const inFlight = new Map();
const INFLIGHT_STALE_MS = parseInt(process.env.MSG_BATCH_INFLIGHT_STALE_MS || "180000", 10);
function isInFlight(leadId) {
  const t = inFlight.get(leadId);
  if (!t) return false;
  if (Date.now() - t > INFLIGHT_STALE_MS) {
    console.warn(`[Batcher] Lead ${leadId} — in-flight lock stale, releasing`);
    inFlight.delete(leadId);
    return false;
  }
  return true;
}

/**
 * push — add an inbound to the batch for this lead.
 *
 * @param {number} leadId
 * @param {object} msg { text, msg_id }
 * @param {function} callback — called with (combinedText, allMessageIds[]) when batch fires
 */
function push(leadId, msg, callback) {
  if (!leadId || !msg) return;

  let bucket = queues.get(leadId);
  if (!bucket) {
    bucket = {
      messages: [],
      timer: null,
      firstArrivedAt: Date.now(),
      callback,
    };
    queues.set(leadId, bucket);
  }

  bucket.messages.push({
    text: msg.text || "",
    msg_id: msg.msg_id || null,
    arrived_at: Date.now(),
  });

  // Update callback every time (latest is freshest closure)
  bucket.callback = callback;

  // Force-flush if queue is large
  if (bucket.messages.length >= MAX_QUEUE_PER_LEAD) {
    return flush(leadId, "max_queue");
  }

  // Force-flush if first message has waited too long
  if (Date.now() - bucket.firstArrivedAt > MAX_WAIT_MS) {
    return flush(leadId, "max_wait");
  }

  // Reset debounce
  if (bucket.timer) clearTimeout(bucket.timer);
  bucket.timer = setTimeout(() => flush(leadId, "debounce"), DEBOUNCE_MS);
}

function flush(leadId, reason = "debounce") {
  const bucket = queues.get(leadId);
  if (!bucket) return;

  if (bucket.timer) clearTimeout(bucket.timer);
  bucket.timer = null;

  // A reply is still being generated for this lead — keep this batch queued;
  // it is flushed as ONE follow-up batch when the current one finishes.
  if (isInFlight(leadId)) {
    bucket.waitingForInFlight = true;
    console.log(`💬 [Batcher] Lead ${leadId} — reply in progress, holding ${bucket.messages.length} msg(s)`);
    return;
  }

  queues.delete(leadId);

  if (!bucket.messages.length) return;

  // Combine: join with single space, normalize whitespace
  const combined = bucket.messages
    .map(m => (m.text || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const ids = bucket.messages.map(m => m.msg_id).filter(Boolean);
  const count = bucket.messages.length;

  console.log(`💬 [Batcher] Lead ${leadId} — flushed ${count} msg(s) (${reason}): "${combined.slice(0, 100)}${combined.length > 100 ? "…" : ""}"`);

  // Fire-and-forget; never let a callback error poison the queue
  const startedAt = Date.now();
  inFlight.set(leadId, startedAt);
  Promise.resolve()
    .then(() => bucket.callback(combined, ids, { count, reason }))
    .catch(err => console.error(`[Batcher] callback error for lead ${leadId}:`, err?.message || err))
    .finally(() => {
      if (inFlight.get(leadId) === startedAt) inFlight.delete(leadId);
      // Messages that arrived meanwhile and already finished debouncing → run now.
      const next = queues.get(leadId);
      if (next && next.waitingForInFlight) {
        try { flush(leadId, "after_inflight"); }
        catch (e) { console.error(`[Batcher] follow-up flush failed for lead ${leadId}:`, e.message); }
      }
    });
}

/**
 * cancel — drop the batch (e.g. rep manually replied, no need for AI)
 */
function cancel(leadId) {
  const bucket = queues.get(leadId);
  if (!bucket) return;
  if (bucket.timer) clearTimeout(bucket.timer);
  queues.delete(leadId);
  console.log(`[Batcher] Lead ${leadId} — batch cancelled`);
}

function stats() {
  return {
    active_buckets: queues.size,
    in_flight: inFlight.size,
    by_lead: Array.from(queues.entries()).map(([leadId, b]) => ({
      lead_id: leadId,
      queued: b.messages.length,
      waiting_ms: Date.now() - b.firstArrivedAt,
    })),
  };
}

module.exports = { push, flush, cancel, stats, DEBOUNCE_MS };
