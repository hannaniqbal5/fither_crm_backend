const express = require("express");
const router = express.Router();
const { registerPushToken } = require("../controllers/pushTokenController");
const authenticate = require("../middleware/auth.middleware");

router.post("/register", authenticate, registerPushToken);

module.exports = router;
