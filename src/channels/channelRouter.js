/**
 * channelRouter — single entry point for all outbound messages.
 *
 * Routes by channel field. Adding a new channel = create one new adapter file.
 * Every adapter must implement: send(person, messageBody, mediaUrl) → { success, messageId, error }
 */

const whatsappChannel  = require("./whatsappChannel");
const instagramChannel = require("./instagramChannel");
const facebookChannel  = require("./facebookChannel");

/**
 * Resolves which channel to use for a person.
 * If channel is "any" or omitted, falls back to the person's source.
 */
function resolveChannel(person, requestedChannel) {
  if (requestedChannel && requestedChannel !== "any") return requestedChannel;

  // Map source → channel
  const source = person?.source || "whatsapp";
  if (source === "instagram") return "instagram";
  if (source === "facebook")  return "facebook";
  return "whatsapp"; // default for whatsapp / website / app / ad / organic / etc.
}

/**
 * send — routes message to the correct channel adapter.
 *
 * @param {object} person       — People model instance (or compatible plain object)
 * @param {string} messageBody  — text body
 * @param {string} channel      — "whatsapp" | "instagram" | "facebook" | "any"
 * @param {string} mediaUrl     — optional media URL
 * @returns {{ success, messageId, channel, error }}
 */
async function send(person, messageBody, channel, mediaUrl = null) {
  const resolved = resolveChannel(person, channel);
  console.log(`📡 [ChannelRouter] Routing to ${resolved} for person ${person.id}`);

  let result;
  switch (resolved) {
    case "whatsapp":
      result = await whatsappChannel.send(person, messageBody, mediaUrl);
      break;
    case "instagram":
      result = await instagramChannel.send(person, messageBody, mediaUrl);
      break;
    case "facebook":
      result = await facebookChannel.send(person, messageBody, mediaUrl);
      break;
    default:
      console.warn(`⚠️  [ChannelRouter] Unknown channel: ${resolved}`);
      return { success: false, channel: resolved, error: `Unknown channel: ${resolved}` };
  }

  return { ...result, channel: resolved };
}

module.exports = { send, resolveChannel };
