// GET /api/media-token — a 12-hour token the dashboard appends to /uploads
// links (?t=…), since <img>/<audio> tags can't send a login header.
// See src/utils/mediaUrl.js.
const express = require("express");
const auth = require("../middleware/auth.middleware");
const { issueMediaToken } = require("../utils/mediaUrl");
const router = express.Router();
router.get("/api/media-token", auth, (req, res) => {
  res.json(issueMediaToken(req.user.repId));
});
module.exports = router;
