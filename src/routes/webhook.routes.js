router.get("/_debug_webhook", (req, res) => {
  res.json({
    mode: req.query["hub.mode"],
    token: req.query["hub.verify_token"],
    challenge: req.query["hub.challenge"],
    expectedExists: Boolean(ENV.WEBHOOK_VERIFY_TOKEN),
    expectedLen: (ENV.WEBHOOK_VERIFY_TOKEN || "").length,
  });
});
