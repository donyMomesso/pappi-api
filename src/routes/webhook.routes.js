const express = require("express");
const ENV = require("../config/env");

const router = express.Router();

router.get("/_debug_webhook2", (req, res) => {
  res.json({
    mode: req.query["hub.mode"],
    token: req.query["hub.verify_token"],
    challenge: req.query["hub.challenge"],
    expectedExists: Boolean(ENV.WEBHOOK_VERIFY_TOKEN),
    expectedLen: (ENV.WEBHOOK_VERIFY_TOKEN || "").length,
  });
});

module.exports = router;
