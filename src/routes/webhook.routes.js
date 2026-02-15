const express = require("express");
const ENV = require("../config/env");

const router = express.Router();

// Verificação do webhook (Meta chama via GET)
router.get("/webhook", (req, res) => {
  // Meta envia: hub.mode, hub.verify_token, hub.challenge
  // Express pode entregar como "hub.verify_token" OU como hub: { verify_token }
  const mode =
    req.query["hub.mode"] ||
    req.query?.hub?.mode ||
    req.query?.mode;

  const token =
    req.query["hub.verify_token"] ||
    req.query?.hub?.verify_token ||
    req.query?.token;

  const challenge =
    req.query["hub.challenge"] ||
    req.query?.hub?.challenge ||
    req.query?.challenge;

  const tokenReceived = typeof token === "string" && token.length > 0;

  // LOG ÚTIL (não vaza segredo, só preview)
  console.log("🔎 Webhook GET params", {
    mode,
    tokenReceived,
    tokenPreview: token ? String(token).slice(0, 4) + "***" : null,
    hasChallenge: Boolean(challenge),
  });

  if (mode === "subscribe" && tokenReceived && token === ENV.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso.");
    return res.status(200).send(String(challenge || ""));
  }

  console.log("❌ Falha na verificação do webhook", {
    mode,
    tokenReceived,
  });

  return res.sendStatus(403);
});

// Recebimento de eventos (Meta chama via POST)
router.post("/webhook", (req, res) => {
  console.log("📩 Webhook POST recebido");
  // responder 200 rápido pra Meta não ficar reenviando
  return res.sendStatus(200);
});

module.exports = router;
