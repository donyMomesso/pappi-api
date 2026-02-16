router.get("/_debug_webhook", (req, res) => {
  res.json({
    mode: req.query["hub.mode"],
    token: req.query["hub.verify_token"],
    challenge: req.query["hub.challenge"],
  });
});
const express = require("express");
const ENV = require("../config/env");

const router = express.Router();

// ===============================
// Helpers
// ===============================
function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function extractIncomingMessages(body) {
  const out = [];
  const entry = body?.entry || [];
  for (const e of entry) {
    const changes = e?.changes || [];
    for (const c of changes) {
      const value = c?.value;
      const messages = value?.messages || [];
      for (const m of messages) {
        out.push({
          from: m.from,
          id: m.id,
          type: m.type,
          text: m.text?.body || "",
          interactive: m.interactive?.button_reply || m.interactive?.list_reply || null,
          raw: m,
        });
      }
    }
  }
  return out;
}

async function waSend(payload) {
  if (!ENV.WHATSAPP_TOKEN || !ENV.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurados.");
  }

  const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || `Erro WhatsApp (${resp.status})`;
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function sendText(to, text) {
  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "text",
    text: { body: text },
  });
}

// ===============================
// Rotas básicas públicas
// ===============================
router.get("/", (req, res) => {
  res.send("Pappi API online ✅");
});

router.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "API da Pappi Pizza",
    time: new Date().toISOString(),
  });
});

router.get("/meta", (req, res) => {
  res.json({
    ok: true,
    app: "API da Pappi Pizza",
    version: "2.0.0",
    env: {
      hasGoogleMaps: Boolean(ENV.GOOGLE_MAPS_API_KEY),
      hasStoreLatLng: Number.isFinite(ENV.STORE_LAT) && Number.isFinite(ENV.STORE_LNG),
      hasWebhookVerifyToken: Boolean(ENV.WEBHOOK_VERIFY_TOKEN),
      hasWhatsappToken: Boolean(ENV.WHATSAPP_TOKEN),
      hasWhatsappPhoneNumberId: Boolean(ENV.WHATSAPP_PHONE_NUMBER_ID),
    },
  });
});

// ===============================
// ✅ Webhook Meta WhatsApp
// ===============================

// 1) Verificação do Webhook (Meta chama via GET)
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === ENV.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado pela Meta");
    return res.status(200).send(challenge);
  }

  console.log("❌ Falha na verificação do webhook", { mode, tokenReceived: Boolean(token) });
  return res.sendStatus(403);
});

// 2) Recebimento de mensagens (Meta chama via POST)
router.post("/webhook", async (req, res) => {
  // Meta quer 200 rápido
  res.sendStatus(200);

  try {
    const msgs = extractIncomingMessages(req.body);

    // log curto pra você ver no Render
    if (!msgs.length) {
      console.log("📩 Webhook recebido (sem messages). Possível status/update:", Object.keys(req.body || {}));
      return;
    }

    for (const msg of msgs) {
      const from = msg.from;
      const text = (msg.text || "").trim();

      console.log("📩 MSG:", { from, type: msg.type, text: text.slice(0, 80) });

      // Resposta simples para provar que está funcionando
      await sendText(
        from,
        `👋 Oi! Eu sou o atendimento da *Pappi Pizza* 🍕\nRecebi sua mensagem: "${text || "(sem texto)"}"\n\nDigite *menu* pra começar.`
      );
    }
  } catch (err) {
    console.error("🔥 Erro no webhook:", err?.message, err?.payload || "");
  }
});

module.exports = router;
