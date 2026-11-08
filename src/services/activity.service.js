const { v4: uuidv4 } = require("uuid");
const { Activity, People } = require("../../models");
const { fireEvent } = require("./event.service");

/**
 * Lead score weights (blueprint spec).
 * Recalculated on every activity write via increment.
 */
const SCORE_WEIGHTS = {
  message_received:    10,
  session_joined:      20,
  form_submitted:      30,
  consultation_booked: 50,
  payment_completed:  100,
};

/**
 * writeActivity — single entry point for logging any touchpoint.
 *
 * 1. Writes row to activities table
 * 2. Updates people.last_activity_at
 * 3. Increments people.lead_score by the weight for this type
 * 4. Fires matching automation event (if applicable)
 */
async function writeActivity(personId, activityType, source = "whatsapp", metadata = null) {
  // 1. Write activity row
  await Activity.create({
    activity_id:   uuidv4(),
    lead_id:       personId,
    activity_type: activityType,
    source,
    metadata,
  });

  // 2. Update last_activity_at
  await People.update(
    { last_activity_at: new Date() },
    { where: { id: personId } }
  );

  // 3. Increment lead_score
  const scoreIncrement = SCORE_WEIGHTS[activityType] || 0;
  if (scoreIncrement > 0) {
    await People.increment("lead_score", { by: scoreIncrement, where: { id: personId } });
  }

  // 4. Fire event if this maps to one
  const eventType = activityTypeToEvent(activityType);
  if (eventType) {
    await fireEvent(personId, eventType, metadata);
  }
}

function activityTypeToEvent(activityType) {
  const map = {
    payment_completed:   "payment_success",
    subscription_started:"subscription_started",
    workout_started:     "workout_started",
    workout_completed:   "workout_completed",
  };
  return map[activityType] ?? null;
}

module.exports = { writeActivity };
