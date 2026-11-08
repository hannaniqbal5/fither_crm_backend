// Re-export so all consumers share the same object (see repState.js for flow).
const { onlineUsers } = require("./repState");
module.exports = onlineUsers;
