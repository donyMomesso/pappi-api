const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== CONFIG =====
const API_KEY = process.env.ATTENDANT_API_KEY;

// In-memory store (temporário)
const ORDERS = new Map(); // orderId -> order

function requireApiKey(req, res, next) {
  const key = req.header("X-API-Key");

  // Se não houver chave configurada no ambiente, mostre erro claro
  if (!API_KEY) {
    return res.status(500).json({
      error: "ServerMisconfigured",
      message: "ATTENDANT_API_KEY não está configurada no servidor (Render > Environment)."
    });
  }

  if (!key || key !== API_KEY) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "API Key inválida ou ausente"
    });
  }

  next();
}

function nowIso() {
  return new Date().toISOString();
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
      if (!Number.isInteger(it.quantity) || it.quantity < 1) errors.push(`items[${i}].quantity deve ser inteiro >= 1.`);
      if (typeof it.unitPrice !== "number" || Number.isNaN(it.unitPrice)) errors.push(`items[${i}].unitPrice deve ser número.`);
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
    whatsappNumbers: ["+55 19 98319-3999", "+55 19 98227-5105"]
  });
});

// ✅ DEBUG (temporário) — confirma se o header está chegando
app.get("/debug-auth", (req, res) => {
  const key = req.header("X-API-Key") || "";
  res.json({
    hasEnvKey: Boolean(process.env.ATTENDANT_API_KEY),
    envKeyLength: (process.env.ATTENDANT_API_KEY || "").length,
    hasHeaderKey: Boolean(key),
    headerKeyLength: key.length
  });
});

// ===== PROTECTED (atendentes) =====

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
    updatedAt: nowIso()
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

// Gerar checkout WhatsApp
app.post("/checkout/whatsapp", requireApiKey, (req, res) => {
  const { orderId, preferredWhatsApp } = req.body || {};
  if (!orderId || typeof orderId !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "orderId é obrigatório." });
  }

  const order = ORDERS.get(orderId);
  if (!order) {
    return res.status(404).json({ error: "NotFound", message: "Pedido não encontrado." });
  }

  const number = (preferredWhatsApp || "+55 19 98227-5105").replace(/\D/g, "");
  const messageText = `Olá! Quero finalizar o pedido na Pappi Pizza.\nPedido: ${orderId}\nTotal: R$ ${order.totals.total.toFixed(2)}`;
  const whatsappUrl = `https://wa.me/${number}?text=${encodeURIComponent(messageText)}`;

  res.json({
    channel: "whatsapp",
    whatsappNumber: preferredWhatsApp || "+55 19 98227-5105",
    whatsappUrl,
    messageText
  });
});

// ===== Render PORT =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));
