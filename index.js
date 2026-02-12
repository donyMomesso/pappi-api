/**
 * Pappi Pizza Actions API (PRO) + WhatsApp Cloud API Webhook
 * - Public:   GET /health, GET /meta, GET /openapi.json (opcional), GET /debug-auth
 * - Protected (X-API-Key): POST /orders, GET /orders, GET /orders/:orderId, POST /checkout/whatsapp
 * - WhatsApp: GET /webhook (verify), POST /webhook (receive messages)
 */

const express = require("express");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== ENV =====
const ATTENDANT_API_KEY = process.env.ATTENDANT_API_KEY; // chave das atendentes (X-API-Key)
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN; // token de verificação do webhook
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // bearer token do WhatsApp Cloud API
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID; // phone_number_id (Meta)

// ===== STORE =====
const ORDERS = new Map(); // orderId -> order

function nowIso() {
  return new Date().toISOString();
}

function requireApiKey(req, res, next) {
  const key = req.header("X-API-Key");

  if (!ATTENDANT_API_KEY) {
    return res.status(500).json({
      error: "ServerMisconfigured",
      message: "ATTENDANT_API_KEY não está configurada no servidor (Render > Environment).",
    });
  }

  if (!key || key !== ATTENDANT_API_KEY) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "API Key inválida ou ausente",
    });
  }

  next();
}

function validateOrderBody(body) {
  const errors = [];

  if (!body || typeof body !== "object") errors.push("Body inválido.");
  if (!body.channel || !["site", "whatsapp"].includes(body.channel))
    errors.push("channel deve ser 'site' ou 'whatsapp'.");

  const c = body.customer;
  if (!c || typeof c !== "object") errors.push("customer é obrigatório.");
  else {
    if (!c.name || typeof c.name !== "string") errors.push("customer.name é obrigatório.");
    if (!c.phone || typeof c.phone !== "string") errors.push("customer.phone é obrigatório.");
  }

  if (!Array.isArray(body.items) || body.items.length < 1) errors.push("items deve ter pelo menos 1 item.");
  else {
    body.items.forEach((it, i) => {
      if (!it.itemId) errors.push(`items[${i}].itemId é obrigatório.`);
      if (!it.name) errors.push(`items[${i}].name é obrigatório.`);
      if (!Number.isInteger(it.quantity) || it.quantity < 1) errors.push(`items[${i}].quantity deve ser inteiro >= 1.`);
      if (typeof it.unitPrice !== "number" || Number.isNaN(it.unitPrice))
        errors.push(`items[${i}].unitPrice deve ser número.`);
    });
  }

  return errors;
}

// ===== PUBLIC =====
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

// Mostra status das envs e se o header chegou (sem expor valores)
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

// ===== PROTECTED (ATENDENTES) =====

// Criar pedido
app.post("/orders", requireApiKey, (req, res) => {
  const errors = validateOrderBody(req.body);
  if (errors.length) return res.status(400).json({ error: "BadRequest", messages: errors });

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

// Listar últimos 30 pedidos
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

// Gerar link de checkout WhatsApp (wa.me)
app.post("/checkout/whatsapp", requireApiKey, (req, res) => {
  const { orderId, preferredWhatsApp } = req.body || {};
  if (!orderId || typeof orderId !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "orderId é obrigatório." });
  }

  const order = ORDERS.get(orderId);
  if (!order) return res.status(404).json({ error: "NotFound", message: "Pedido não encontrado." });

  const number = (preferredWhatsApp || "+55 19 98227-5105").replace(/\D/g, "");
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

// ===== WHATSAPP CLOUD API =====

// Envia texto via WhatsApp Cloud API
async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("⚠️ WhatsApp envs faltando (WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID).");
    return { ok: false, error: "WhatsAppEnvMissing" };
  }

  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

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

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.log("❌ Erro ao enviar WhatsApp:", resp.status, data);
    return { ok: false, status: resp.status, data };
  }
  return { ok: true, data };
}

// Verificação do webhook (Meta chama GET com challenge)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado!");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recebe eventos (mensagens, status etc)
app.post("/webhook", async (req, res) => {
  // Responda 200 rápido (Meta exige)
  res.sendStatus(200);

  try {
    const body = req.body;

    if (!body || body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Mensagens do cliente
    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const msg = messages[0];
    const from = msg.from; // número do cliente (somente dígitos)
    const text = msg.text?.body || "";
    const lower = text.toLowerCase().trim();

    console.log("📩 WhatsApp msg:", { from, text });

    // ===== RESPOSTAS AUTOMÁTICAS (base) =====
    // 1) Saudação
    if (["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite"].includes(lower)) {
      await sendWhatsAppText(
        from,
        "Olá! 👋 Sou o atendente automático da Pappi Pizza 🍕\n\n" +
          "Me diga o que você quer:\n" +
          "1) Cardápio\n" +
          "2) Fazer pedido\n" +
          "3) Falar com atendente"
      );
      return;
    }

    // 2) Cardápio
    if (lower.includes("cardapio") || lower.includes("cardápio") || lower === "1") {
      await sendWhatsAppText(
        from,
        "Aqui está nosso cardápio 👇\n" +
          "https://app.cardapioweb.com/pappi_pizza?s=dony\n\n" +
          "Se quiser pedir por aqui, me diga: sabor + tamanho (ex: Calabresa grande)."
      );
      return;
    }

    // 3) Falar com atendente (humano)
    if (lower.includes("atendente") || lower.includes("humano") || lower === "3") {
      await sendWhatsAppText(
        from,
        "Certo! ✅ Já vou te direcionar para uma atendente.\n" +
          "Enquanto isso, pode me dizer seu bairro e o que deseja?"
      );
      return;
    }

    // 4) Tentativa simples de “capturar pedido”
    // Ex: "calabresa grande", "frango catupiry media"
    if (lower === "2" || lower.includes("pizza") || lower.includes("calabresa") || lower.includes("frango")) {
      // Regra simples: se contiver "grande/média/broto"
      let size = null;
      if (lower.includes("grande")) size = "grande";
      else if (lower.includes("media") || lower.includes("média")) size = "média";
      else if (lower.includes("broto")) size = "broto";

      if (!size) {
        await sendWhatsAppText(
          from,
          "Perfeito 😄 Qual tamanho você quer?\n" +
            "• Broto\n• Média\n• Grande\n\n" +
            "Responda assim: *Calabresa grande*"
        );
        return;
      }

      await sendWhatsAppText(
        from,
        "Show! ✅ Anotei seu pedido.\n" +
          `Você pediu: *${text}*\n\n` +
          "Agora me diga:\n" +
          "• Nome\n• Endereço (rua, número, bairro)\n• Forma de pagamento (pix/cartão/dinheiro)"
      );
      return;
    }

    // 5) Fallback
    await sendWhatsAppText(
      from,
      "Entendi 😊\n" +
        "Para agilizar, me diga:\n" +
        "• Sabor + tamanho (ex: *Calabresa grande*)\n" +
        "ou digite *cardápio* para ver as opções."
    );
  } catch (err) {
    console.log("❌ Erro no webhook:", err?.message);
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));
