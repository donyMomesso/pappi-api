/**
 * Pappi Pizza API (PRO) - Render + WhatsApp Cloud API
 * Endpoints públicos: /health, /meta
 * Endpoints internos (atendentes): /orders, /orders/:orderId, /checkout/whatsapp, /debug-auth
 * Webhook WhatsApp: GET/POST /webhook
 */

const express = require("express");
const app = express();

app.use(express.json({ limit: "1mb" }));

// =========================
// CONFIG (Render Environment)
// =========================
const ATTENDANT_API_KEY = process.env.ATTENDANT_API_KEY; // usado pelo GPT Actions (X-API-Key)

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // Bearer token (Meta Cloud API)
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID; // ex: 901776653029199
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN; // ex: PAPPI_VERIFY_2026

// In-memory store (temporário)
const ORDERS = new Map(); // orderId -> order

// =========================
// HELPERS
// =========================
function nowIso() {
  return new Date().toISOString();
}

function onlyDigits(str) {
  return String(str || "").replace(/\D/g, "");
}

function requireApiKey(req, res, next) {
  const key = req.header("X-API-Key");

  if (!ATTENDANT_API_KEY) {
    return res.status(500).json({
      error: "ServerMisconfigured",
      message:
        "ATTENDANT_API_KEY não está configurada no servidor (Render > Environment).",
    });
  }

  if (!key || key !== ATTENDANT_API_KEY) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "API Key inválida ou ausente",
    });
  }

  return next();
}

function validateOrderBody(body) {
  const errors = [];
  if (!body || typeof body !== "object") errors.push("Body inválido.");

  if (!body.channel || !["site", "whatsapp"].includes(body.channel)) {
    errors.push("channel deve ser 'site' ou 'whatsapp'.");
  }

  const c = body.customer;
  if (!c || typeof c !== "object") errors.push("customer é obrigatório.");
  else {
    if (!c.name || typeof c.name !== "string") errors.push("customer.name é obrigatório.");
    if (!c.phone || typeof c.phone !== "string") errors.push("customer.phone é obrigatório.");
  }

  if (!Array.isArray(body.items) || body.items.length < 1) {
    errors.push("items deve ter pelo menos 1 item.");
  } else {
    body.items.forEach((it, i) => {
      if (!it.itemId) errors.push(`items[${i}].itemId é obrigatório.`);
      if (!it.name) errors.push(`items[${i}].name é obrigatório.`);
      if (!Number.isInteger(it.quantity) || it.quantity < 1) {
        errors.push(`items[${i}].quantity deve ser inteiro >= 1.`);
      }
      if (typeof it.unitPrice !== "number" || Number.isNaN(it.unitPrice)) {
        errors.push(`items[${i}].unitPrice deve ser número.`);
      }
    });
  }

  return errors;
}

// =========================
// PUBLIC
// =========================
app.get("/health", (req, res) => {
  res.json({ ok: true, app: "Pappi Pizza API", time: nowIso() });
});

app.get("/meta", (req, res) => {
  res.json({
    storeName: "Pappi Pizza",
    menuUrl: "https://app.cardapioweb.com/pappi_pizza?s=dony",
    whatsappNumbers: ["+55 19 98319-3999", "+55 19 98227-5105"],
  });
});

// =========================
// DEBUG
// =========================
app.get("/debug-auth", (req, res) => {
  const headerKey = req.header("X-API-Key") || "";
  res.json({
    hasEnvAttendantKey: Boolean(ATTENDANT_API_KEY),
    attendantKeyLength: (ATTENDANT_API_KEY || "").length,
    hasHeaderKey: Boolean(headerKey),
    headerKeyLength: headerKey.length,

    hasWhatsappToken: Boolean(WHATSAPP_TOKEN),
    hasWhatsappPhoneNumberId: Boolean(WHATSAPP_PHONE_NUMBER_ID),
    hasWebhookVerifyToken: Boolean(WEBHOOK_VERIFY_TOKEN),
  });
});

// =========================
// WHATSAPP WEBHOOK (META)
// =========================

// 1) Verificação (Meta chama GET /webhook?hub.*)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!WEBHOOK_VERIFY_TOKEN) {
    return res.status(500).send("WEBHOOK_VERIFY_TOKEN não configurado no servidor.");
  }

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso!");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// 2) Recebe mensagens
app.post("/webhook", async (req, res) => {
  // Meta exige resposta rápida 200
  res.sendStatus(200);

  try {
    const body = req.body;

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    if (!message) return;

    const from = message.from; // ex: "5511999999999"
    const text = message.text?.body?.trim() || "";

    // Evitar responder status/eco
    // (se vierem outros tipos, ignore)
    if (!from) return;

    // ===== LÓGICA DE ATENDIMENTO (MVP) =====
    let reply =
      "Olá! 👋 Eu sou a atendente automática da *Pappi Pizza* 🍕\n\n" +
      "Me diga o que você quer pedir e se é *retirada* ou *entrega*.\n\n" +
      "📖 Cardápio: https://app.cardapioweb.com/pappi_pizza?s=dony";

    if (/card[aá]pio|menu/i.test(text)) {
      reply = "🍕 Cardápio Pappi Pizza:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony";
    } else if (/oi|ol[aá]|bom dia|boa tarde|boa noite/i.test(text)) {
      reply =
        "Olá! 👋 Bem-vindo(a) à *Pappi Pizza* 🍕\n\n" +
        "Quer pedir *pizza* ou *bebida*?\n" +
        "E é *retirada* ou *entrega*?\n\n" +
        "📖 Cardápio: https://app.cardapioweb.com/pappi_pizza?s=dony";
    } else if (/endere[cç]o|entrega|taxa/i.test(text)) {
      reply =
        "Para entrega, me diga:\n" +
        "1) Rua e nº\n2) Bairro\n3) Referência\n\n" +
        "Aí eu confirmo a taxa e finalizamos ✅";
    }

    await sendWhatsAppText(from, reply);
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// Envia mensagem de texto via Cloud API
async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.error("WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID ausentes no Render.");
    return;
  }

  const url = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  if (!resp.ok) console.error("WhatsApp send failed:", data);
  return data;
}

// =========================
// PROTECTED (ATENDENTES / GPT ACTIONS)
// =========================

// Criar pedido
app.post("/orders", requireApiKey, (req, res) => {
  const errors = validateOrderBody(req.body);
  if (errors.length) {
    return res.status(400).json({ error: "BadRequest", messages: errors });
  }

  const orderId = "ord_" + Math.random().toString(36).slice(2, 10);

  const subtotal = req.body.items.reduce((acc, it) => acc + it.quantity * it.unitPrice, 0);
  const deliveryFee = typeof req.body.deliveryFee === "number" ? req.body.deliveryFee : 0;
  const discount = typeof req.body.discount === "number" ? req.body.discount : 0;
  const total = Math.max(0, subtotal + deliveryFee - discount);

  const order = {
    id: orderId,
    status: "received",
    channel: req.body.channel,
    customer: req.body.customer,
    items: req.body.items,
    totals: { subtotal, deliveryFee, discount, total },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  ORDERS.set(orderId, order);
  return res.status(201).json(order);
});

// Listar últimos pedidos (até 30)
app.get("/orders", requireApiKey, (req, res) => {
  const arr = Array.from(ORDERS.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 30);

  res.json(arr);
});

// Buscar pedido por ID
app.get("/orders/:orderId", requireApiKey, (req, res) => {
  const order = ORDERS.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: "NotFound", message: "Pedido não encontrado." });
  res.json(order);
});

// Gerar checkout WhatsApp (link wa.me)
app.post("/checkout/whatsapp", requireApiKey, (req, res) => {
  const { orderId, preferredWhatsApp } = req.body || {};
  if (!orderId || typeof orderId !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "orderId é obrigatório." });
  }

  const order = ORDERS.get(orderId);
  if (!order) {
    return res.status(404).json({ error: "NotFound", message: "Pedido não encontrado." });
  }

  const number = onlyDigits(preferredWhatsApp || "+55 19 98227-5105");

  const messageText =
    `Olá! Quero finalizar meu pedido na *Pappi Pizza* 🍕\n` +
    `Pedido: ${orderId}\n\n` +
    `Total: *R$ ${order.totals.total.toFixed(2)}*\n` +
    `Cardápio: https://app.cardapioweb.com/pappi_pizza?s=dony`;

  const whatsappUrl = `https://wa.me/${number}?text=${encodeURIComponent(messageText)}`;

  res.json({
    channel: "whatsapp",
    whatsappNumber: preferredWhatsApp || "+55 19 98227-5105",
    whatsappUrl,
    messageText,
  });
});
// ===== WHATSAPP WEBHOOK =====

app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado!");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object) {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const messages = value?.messages;

      if (messages) {
        const from = messages[0].from;
        const text = messages[0].text?.body;

        console.log("📲 Mensagem recebida:", from, text);

        // 👉 Aqui depois vamos ligar com sua API de pedidos
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro webhook:", err);
    res.sendStatus(500);
  }
});

// =========================
// START (Render)
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));
