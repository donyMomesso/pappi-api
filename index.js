const express = require("express");
const app = express();

app.use(express.json());

// ===== CONFIG =====
const API_KEY = process.env.ATTENDANT_API_KEY || "troque-essa-chave";

// Middleware: protege endpoints internos
function requireApiKey(req, res, next) {
  const key = req.header("X-API-Key");
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized", message: "API Key inválida ou ausente" });
  }
  next();
}

// ===== PUBLIC =====
app.get("/health", (req, res) => {
  res.json({ ok: true, app: "Pappi Pizza API" });
});

app.get("/meta", (req, res) => {
  res.json({
    storeName: "Pappi Pizza",
    menuUrl: "https://app.cardapioweb.com/pappi_pizza?s=dony",
    whatsappNumbers: ["+55 19 98319-3999", "+55 19 98227-5105"]
  });
});

// ===== PROTECTED (atendentes) =====
app.post("/orders", requireApiKey, (req, res) => {
  // Aqui você pode salvar em banco depois; por enquanto devolve o que recebeu.
  const orderId = "ord_" + Math.random().toString(36).slice(2, 8);

  res.status(201).json({
    id: orderId,
    status: "received",
    channel: req.body.channel || "whatsapp",
    customer: req.body.customer,
    items: req.body.items,
    totals: req.body.totals || { subtotal: 0, total: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
});

app.post("/checkout/whatsapp", requireApiKey, (req, res) => {
  const { orderId, preferredWhatsApp } = req.body || {};
  const number = (preferredWhatsApp || "+55 19 98227-5105").replace(/\D/g, ""); // só números
  const msg = encodeURIComponent(`Olá! Quero finalizar o pedido na Pappi Pizza. Pedido: ${orderId}`);
  const url = `https://wa.me/${number}?text=${msg}`;

  res.json({
    channel: "whatsapp",
    whatsappNumber: preferredWhatsApp || "+55 19 98227-5105",
    whatsappUrl: url,
    messageText: `Olá! Quero finalizar o pedido na Pappi Pizza. Pedido: ${orderId}`
  });
});

// Render PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));
