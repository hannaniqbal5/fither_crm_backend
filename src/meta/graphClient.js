/**
 * graphClient.js — thin wrapper around Meta Graph API.
 *
 * One client for both Facebook Messenger and Instagram (since linked Pages share one
 * Graph API surface). Handles:
 *   - sending DMs
 *   - replying to comments (public + private)
 *   - fetching user profile (name, avatar)
 *
 * Token: pass META_PAGE_ACCESS_TOKEN at construction.
 * Version: locked to v21.0 — bump explicitly when Meta deprecates.
 *
 * Uses native fetch (Node 18+).
 */

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

class MetaGraphError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "MetaGraphError";
    this.status = status;
    this.body = body;
  }
}

async function callGraph(method, path, { token, body, query } = {}) {
  if (process.env.OUTBOUND_DISABLED === "1" && String(method).toUpperCase() !== "GET") {
    console.warn(`🛑 [OUTBOUND_DISABLED] Meta Graph ${method} ${path} BLOCKED`);
    throw new Error("Outbound messaging is disabled (OUTBOUND_DISABLED=1)");
  }
  const params = new URLSearchParams(query || {});
  if (token) params.set("access_token", token);

  const url = `${GRAPH_BASE}${path}?${params.toString()}`;

  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data?.error?.message || `Graph API ${res.status}`;
    throw new MetaGraphError(msg, res.status, data);
  }
  return data;
}

/**
 * Send a text DM via Messenger / Instagram messaging API.
 * Same endpoint, channel determined by the page<->user relationship.
 *
 * @param {string} pageAccessToken
 * @param {string} recipientPsid
 * @param {string} text
 * @returns {Promise<{ message_id, recipient_id }>}
 */
async function sendTextMessage(pageAccessToken, recipientPsid, text) {
  return callGraph("POST", "/me/messages", {
    token: pageAccessToken,
    body: {
      recipient: { id: recipientPsid },
      message:   { text: text },
      messaging_type: "RESPONSE",
    },
  });
}

/**
 * Send an image attachment.
 */
async function sendImageMessage(pageAccessToken, recipientPsid, imageUrl) {
  return callGraph("POST", "/me/messages", {
    token: pageAccessToken,
    body: {
      recipient: { id: recipientPsid },
      message: {
        attachment: {
          type: "image",
          payload: { url: imageUrl, is_reusable: true },
        },
      },
      messaging_type: "RESPONSE",
    },
  });
}

/**
 * Reply publicly to a Facebook / Instagram comment.
 * Visible to all viewers of the post.
 */
async function replyToComment(pageAccessToken, commentId, text) {
  return callGraph("POST", `/${commentId}/replies`, {
    token: pageAccessToken,
    body: { message: text },
  });
}

/**
 * Send a private DM in response to a public comment.
 * Meta allows this ONCE per comment, must be within 7 days.
 * The recipient is identified by `comment_id` instead of PSID.
 */
async function privateReplyToComment(pageAccessToken, commentId, text) {
  return callGraph("POST", "/me/messages", {
    token: pageAccessToken,
    body: {
      recipient: { comment_id: commentId },
      message:   { text: text },
    },
  });
}

/**
 * Fetch user profile (name, avatar). Useful when a new lead messages —
 * stores their display name in the leads table.
 */
async function getUserProfile(pageAccessToken, psid) {
  // Instagram and Facebook use slightly different fields, but both support `name`
  return callGraph("GET", `/${psid}`, {
    token: pageAccessToken,
    query: { fields: "name,profile_pic" },
  });
}

/**
 * Health check — fetches the Page's own info to confirm token + connection.
 */
async function getPageInfo(pageAccessToken, pageId) {
  return callGraph("GET", `/${pageId}`, {
    token: pageAccessToken,
    query: { fields: "id,name,instagram_business_account" },
  });
}

/**
 * Refresh the long-lived Page Access Token.
 * Page tokens technically don't expire if obtained from a long-lived user token,
 * but if you need to refresh (e.g. user reinstalled), you'd call this with the
 * App credentials.
 *
 * For FitHer's current setup, just monitor for token errors and re-fetch via
 * the Meta dashboard if needed.
 */
async function refreshPageToken(appId, appSecret, currentToken) {
  return callGraph("GET", "/oauth/access_token", {
    query: {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: currentToken,
    },
  });
}

module.exports = {
  sendTextMessage,
  sendImageMessage,
  replyToComment,
  privateReplyToComment,
  getUserProfile,
  getPageInfo,
  refreshPageToken,
  MetaGraphError,
  GRAPH_VERSION,
};
