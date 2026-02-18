const express = require("express");
const ENV = require("../config/env");
const router = express.Router();

// GET /webhook: Apenas para o Facebook validar seu servidor
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === ENV.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

module.exports = router;
