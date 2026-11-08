const { v4: uuidv4 } = require("uuid");
const { Event } = require("../../models");

/**
 * fireEvent — writes a row to events table with processed = 0.
 * The automation engine (Phase 2) polls this table every 30s.
 * Phase 1: we just write rows so they're ready when the engine is built.
 */
async function fireEvent(personId, eventType, payload = null) {
  try {
    await Event.create({
      event_id:   uuidv4(),
      lead_id:    personId,
      event_type: eventType,
      payload,
      processed:  0,
    });
    console.log(`⚡ Event fired: ${eventType} for person ${personId}`);
  } catch (err) {
    // Event writes never crash the main flow
    console.error(`❌ Failed to fire event ${eventType} for person ${personId}:`, err.message);
  }
}

module.exports = { fireEvent };
