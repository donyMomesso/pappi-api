const express = require("express");
const ENV = require("../config/env");

const router = express.Router();

/**
 * Verificação do Webhook (Meta)
 * GET /webhook?hub.mode=subscribe&hub.verify_token=XXX&hub.challenge=YYY
 */
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === ENV.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  console.error("❌ Falha na verificação do webhook", {
    mode,
    tokenReceived: Boolean(token),
  });

  return res.sendStatus(403);
});

/**
 * Recebimento de eventos do WhatsApp
 * POST /webhook
 */
router.post("/webhook", (req, res) => {
  // Só confirma recebimento para o Meta não ficar reenviando
  // (Depois a gente processa e manda pro atendente/fluxo)
  return res.sendStatus(200);
});

module.exports = router;
