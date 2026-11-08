/**
 * Rep connection state for Socket vs Firebase push.
 *
 * Flow:
 * - repId in onlineUsers → use SOCKET for real-time updates (no push).
 * - repId NOT in onlineUsers → use FIREBASE push (stored FCM token).
 *
 * Background: frontend emits "background" → we remove from onlineUsers (and mark in repInBackground).
 * Foreground: frontend emits "foreground" or new connection → we add to onlineUsers.
 * Disconnect: socket disconnects → we remove from onlineUsers (and repInBackground).
 */

const onlineUsers = {}; // repId -> socket (only when tab is in foreground and connected)
const repInBackground = new Set(); // repIds that are connected but tab is hidden (so we use Firebase)

module.exports = {
  onlineUsers,
  repInBackground,
};
