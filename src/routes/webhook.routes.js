const express = require("express");
const ENV = require("../config/env");

const router = express.Router();

router.get("/webhook", (req, res) => {
  // aceita 2 formatos: "hub.verify_token" OU hub: { verify_token }
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

  if (mode === "subscribe" && tokenReceived && token === ENV.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso.");
    return res.status(200).send(String(challenge || ""));
  }

  console.log("❌ Falha na verificação do webhook", {
    mode,
    tokenReceived,
    tokenPreview: token ? String(token).slice(0, 4) + "***" : null
  });

  return res.sendStatus(403);
});

module.exports = router;
