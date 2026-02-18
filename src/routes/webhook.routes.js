const express = require("express");
const ENV = require("../config/env");
const router = express.Router();

// Verificação do Webhook (Meta)
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === ENV.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recebimento de mensagens (POST)
router.post("/webhook", (req, res) => {
  // A lógica de processamento continua no public.routes por enquanto
  return res.sendStatus(200);
});

module.exports = router;
