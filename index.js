/**
 * Pappi API - WhatsApp Cloud + Cardápio Web + GPT Actions
 * Node 18+ (fetch nativo)
 */

const express = require("express");
const crypto = require("crypto");

const app = express();

// WhatsApp manda JSON; limit ok
app.use(express.json({ limit: "2mb" }));

// ===== ENV =====
const API_KEY = process.env.ATTENDANT_API_KEY || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "";

const CARDAPIOWEB_BASE_URL =
  process.env.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN || "";

// In-memory store (temporário)
const ORDERS = new Map(); // orderId -> order

function nowIso() {
  return new Date().toISOString();
}

function requireApiKey(req, res, next) {
  const key = req.header("X-API-Key");
  if (!API_KEY) {
    return res.status(500).json({
      error: "ServerMisconfigured",
      message:
        "ATTENDANT_API_KEY não está configurada no servidor (Render > Environment).",
    });
  }
  if (!key || key !== API_KEY) {
    return res
      .status(401)
      .json({ error: "Unauthorized", message: "API Key inválida ou ausente" });
  }
  next();
}

// (Opcional) validar assinatura do webhook da Meta (recomendado)
// Para isso você precisaria do APP SECRET, mas como você não passou, deixei DESLIGADO.
// Se quiser ligar depois, me manda que eu ajusto.
function verifyMetaSignature(req) {
  return true;
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

// Debug rápido (não expõe chaves)
app.get("/debug-auth", (req, res) => {
  const headerKey = req.header("X-API-Key") || "";
  res.json({
    hasEnvAttendantKey: Boolean(process.env.ATTENDANT_API_KEY),
    attendantKeyLength: (process.env.ATTENDANT_API_KEY || "").length,
    hasHeaderKey: Boolean(headerKey),
    headerKeyLength: headerKey.length,
    hasWhatsappToken: Boolean(WHATSAPP_TOKEN),
    hasWhatsappPhoneNumberId: Boolean(WHATSAPP_PHONE_NUMBER_ID),
    hasWebhookVerifyToken: Boolean(WEBHOOK_VERIFY_TOKEN),
    hasCardapioWebToken: Boolean(CARDAPIOWEB_TOKEN),
    cardapioWebBaseUrl: CARDAPIOWEB_BASE_URL,
  });
});

// ===== CARDAPIO WEB (helpers) =====
async function cardapioWebFetch(path, { method = "GET", body } = {}) {
  if (!CARDAPIOWEB_TOKEN) {
    throw new Error(
      "CARDAPIOWEB_TOKEN não configurado no Render (Environment)."
    );
  }
  const url = `${CARDAPIOWEB_BASE_URL}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      "X-API-KEY": CARDAPIOWEB_TOKEN, // ✅ padrão Cardápio Web
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    const msg = data?.message || data?.error || text || "Erro Cardápio Web";
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }

  return data;
}

// Consulta pedido por ID (Cardápio Web)
async function consultarPedidoCardapioWeb(orderId) {
  // Obs: o path exato pode variar no Cardápio Web dependendo da versão do doc.
  // Se este der 404, me manda o nome exato do endpoint no Stoplight que eu ajusto o path.
  return cardapioWebFetch(`/orders/${encodeURIComponent(orderId)}`);
}

// Listar pedidos (polling)
async function listarPedidosCardapioWeb(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return cardapioWebFetch(`/orders${qs ? `?${qs}` : ""}`);
}

// Alterar status (exemplos)
// Esses paths também podem variar de acordo com a doc. Ajusto se você me mandar o nome exato no Stoplight.
async function aceitarPedidoCardapioWeb(orderId) {
  return cardapioWebFetch(`/orders/${encodeURIComponent(orderId)}/accept`, {
    method: "POST",
  });
}

async function iniciarPreparacaoCardapioWeb(orderId) {
  return cardapioWebFetch(
    `/orders/${encodeURIComponent(orderId)}/start_preparation`,
    { method: "POST" }
  );
}

async function marcarProntoCardapioWeb(orderId) {
  return cardapioWebFetch(`/orders/${encodeURIComponent(orderId)}/ready`, {
    method: "POST",
  });
}

async function finalizarPedidoCardapioWeb(orderId) {
  return cardapioWebFetch(`/orders/${encodeURIComponent(orderId)}/close`, {
    method: "POST",
  });
}

// ===== WHATSAPP CLOUD (helpers) =====
async function sendWhatsAppText(toNumber, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error(
      "WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurados."
    );
  }

  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: String(toNumber).replace(/\D/g, ""),
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
    const msg =
      data?.error?.message ||
      data?.message ||
      `Erro ao enviar WhatsApp (${resp.status})`;
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }

  return data;
}

// Extrai mensagens do webhook Meta (WhatsApp Cloud)
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
          timestamp: m.timestamp,
          type: m.type,
          text: m.text?.body || "",
          raw: m,
        });
      }
    }
  }
  return out;
}

// ===== WEBHOOK WHATSAPP (Meta) =====

// 1) Verificação (GET) — é isso que faz o “Verificar e salvar” funcionar
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2) Receber mensagens (POST)
app.post("/webhook", async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) {
      return res.sendStatus(403);
    }

    // WhatsApp espera 200 rápido
    res.sendStatus(200);

    const msgs = extractIncomingMessages(req.body);

    for (const msg of msgs) {
      // Ignora mensagens vazias
      const text = (msg.text || "").trim();
      if (!text) continue;

      // ===== LÓGICA DO ATENDENTE AUTOMÁTICO =====
      // Comandos:
      // - "menu" / "cardapio"
      // - "pedido 123" (consulta no Cardápio Web)
      // - fallback: responde instruções

      const lower = text.toLowerCase();

      // 1) Cardápio
      if (lower.includes("menu") || lower.includes("cardápio") || lower.includes("cardapio")) {
        await sendWhatsAppText(
          msg.from,
          `🍕 *Pappi Pizza* — Cardápio online:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony\n\nSe quiser acompanhar pedido, envie: *pedido 123* (com o número/ID).`
        );
        continue;
      }

      // 2) Consulta pedido (Cardápio Web)
      // Aceita: "pedido 7637462" ou "pedido: 7637462"
      const match = lower.match(/pedido\s*[:#-]?\s*([a-z0-9_-]+)/i);
      if (match && match[1]) {
        const orderId = match[1].trim();

        try {
          const order = await consultarPedidoCardapioWeb(orderId);

          const status = order?.status || "desconhecido";
          const total = order?.total != null ? `R$ ${Number(order.total).toFixed(2)}` : "—";
          const display = order?.display_id != null ? `#${order.display_id}` : orderId;

          await sendWhatsAppText(
            msg.from,
            `📦 *Pedido ${display}*\nStatus: *${status}*\nTotal: *${total}*\n\nSe precisar, mande *menu* para ver o cardápio.`
          );
        } catch (err) {
          await sendWhatsAppText(
            msg.from,
            `Não consegui localizar o pedido *${orderId}* agora. 😕\nConfere se o ID está certo.\n\nDica: mande *menu* para ver o cardápio.`
          );
        }

        continue;
      }

      // 3) Fallback padrão
      await sendWhatsAppText(
        msg.from,
        `Olá! 👋 Sou o atendimento automático da *Pappi Pizza*.\n\n✅ Para ver o cardápio: mande *menu*\n✅ Para acompanhar: mande *pedido 123*\n\nSe preferir, diga o que você precisa.`
      );
    }
  } catch (err) {
    // Não quebra o webhook
    console.error("Webhook error:", err?.message, err?.payload || "");
  }
});

// ===== PROTECTED (GPT Actions / atendentes) =====

// Criar pedido interno (seu sistema)
app.post("/orders", requireApiKey, (req, res) => {
  const body = req.body || {};

  if (!body.channel || !["site", "whatsapp"].includes(body.channel)) {
    return res
      .status(400)
      .json({ error: "BadRequest", message: "channel deve ser 'site' ou 'whatsapp'." });
  }
  if (!body.customer?.name || !body.customer?.phone) {
    return res
      .status(400)
      .json({ error: "BadRequest", message: "customer.name e customer.phone são obrigatórios." });
  }
  if (!Array.isArray(body.items) || body.items.length < 1) {
    return res
      .status(400)
      .json({ error: "BadRequest", message: "items deve ter pelo menos 1 item." });
  }

  const orderId = "ord_" + Math.random().toString(36).slice(2, 10);

  const subtotal = body.items.reduce(
    (acc, it) => acc + Number(it.quantity || 0) * Number(it.unitPrice || 0),
    0
  );
  const deliveryFee = typeof body.deliveryFee === "number" ? body.deliveryFee : 0;
  const discount = typeof body.discount === "number" ? body.discount : 0;
  const total = Math.max(0, subtotal + deliveryFee - discount);

  const order = {
    id: orderId,
    status: "received",
    channel: body.channel,
    customer: body.customer,
    items: body.items,
    totals: { subtotal, deliveryFee, discount, total },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  ORDERS.set(orderId, order);
  return res.status(201).json(order);
});

// Listar pedidos internos
app.get("/orders", requireApiKey, (req, res) => {
  const arr = Array.from(ORDERS.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 30);
  res.json(arr);
});

// Buscar pedido interno
app.get("/orders/:orderId", requireApiKey, (req, res) => {
  const order = ORDERS.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: "NotFound", message: "Pedido não encontrado." });
  res.json(order);
});

// Gerar checkout WhatsApp (link)
app.post("/checkout/whatsapp", requireApiKey, (req, res) => {
  const { orderId, preferredWhatsApp } = req.body || {};
  if (!orderId || typeof orderId !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "orderId é obrigatório." });
  }

  const order = ORDERS.get(orderId);
  if (!order) return res.status(404).json({ error: "NotFound", message: "Pedido não encontrado." });

  const number = (preferredWhatsApp || "+55 19 98227-5105").replace(/\D/g, "");
  const messageText =
    `Olá! Quero finalizar o pedido na Pappi Pizza.\n` +
    `Pedido: ${orderId}\n` +
    `Total: R$ ${order.totals.total.toFixed(2)}\n` +
    `Cardápio: https://app.cardapioweb.com/pappi_pizza?s=dony`;

  const whatsappUrl = `https://wa.me/${number}?text=${encodeURIComponent(messageText)}`;

  res.json({
    channel: "whatsapp",
    whatsappNumber: preferredWhatsApp || "+55 19 98227-5105",
    whatsappUrl,
    messageText,
  });
});

// ===== Run =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));
