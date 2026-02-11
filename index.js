const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== CONFIG =====
const API_KEY = process.env.ATTENDANT_API_KEY;

// WhatsApp padrão da Pappi
const DEFAULT_WPP = "+55 19 98227-5105";

// In-memory store (temporário)
const ORDERS = new Map();

// ===== AUTH =====
function requireApiKey(req, res, next) {
  const key = req.header("X-API-Key");

  if (!API_KEY) {
    return res.status(500).json({
      error: "ServerMisconfigured",
      message: "ATTENDANT_API_KEY não configurada no Render."
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

// ===== DEBUG AUTH (TEMPORÁRIO) =====
app.get("/debug-auth", (req, res) => {
  const key = req.header("X-API-Key") || "";
  res.json({
    hasEnvKey: Boolean(process.env.ATTENDANT_API_KEY),
    envKeyLength: (process.env.ATTENDANT_API_KEY || "").length,
    hasHeaderKey: Boolean(key),
    headerKeyLength: key.length
  });
});

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

// ===== VALIDAR PEDIDO =====
function validateOrderBody(body) {
  const errors = [];

  if (!body.channel) errors.push("channel obrigatório.");

  const c = body.customer;
  if (!c || !c.name || !c.phone) errors.push("customer.name e customer.phone obrigatórios.");

  if (!Array.isArray(body.items) || body.items.length < 1)
    errors.push("items precisa ter pelo menos 1.");

  return errors;
}

// ===== CRIAR PEDIDO =====
app.post("/orders", requireApiKey, (req, res) => {
  const errors = validateOrderBody(req.body);

  if (errors.length) {
    return res.status(400).json({ error: "BadRequest", messages: errors });
  }

  const orderId = "ord_" + Math.random().toString(36).slice(2, 10);

  const subtotal = req.body.items.reduce(
    (acc, it) => acc + it.quantity * it.unitPrice,
    0
  );

  const deliveryFee = req.body.deliveryFee || 0;
  const discount = req.body.discount || 0;
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

  res.status(201).json(order);
});

// ===== LISTAR PEDIDOS =====
app.get("/orders", requireApiKey, (req, res) => {
  res.json(Array.from(ORDERS.values()));
});

// ===== CHECKOUT WHATSAPP =====
app.post("/checkout/whatsapp", requireApiKey, (req, res) => {
  const { orderId, preferredWhatsApp } = req.body || {};

  const order = ORDERS.get(orderId);

  if (!order) {
    return res.status(404).json({
      error: "NotFound",
      message: "Pedido não encontrado."
    });
  }

  const number = (preferredWhatsApp || DEFAULT_WPP).replace(/\D/g, "");

  const itemsText = order.items
    .map(it => `• ${it.quantity}x ${it.name} (R$ ${it.unitPrice.toFixed(2)})`)
    .join("\n");

  const messageText =
    `Olá! Quero finalizar meu pedido na *Pappi Pizza* 🍕\n` +
    `Pedido: ${orderId}\n\n` +
    `Itens:\n${itemsText}\n\n` +
    `Total: *R$ ${order.totals.total.toFixed(2)}*\n` +
    `Cardápio: https://app.cardapioweb.com/pappi_pizza?s=dony`;

  const whatsappUrl = `https://wa.me/${number}?text=${encodeURIComponent(messageText)}`;

  res.json({
    channel: "whatsapp",
    whatsappNumber: preferredWhatsApp || DEFAULT_WPP,
    whatsappUrl,
    messageText
  });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));
