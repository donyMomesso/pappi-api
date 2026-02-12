/**
 * Pappi API - WhatsApp Cloud + Cardápio Web + GPT Actions
 * Node 18+ (fetch nativo)
 */

const express = require("express");
const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== ENV =====
const API_KEY = process.env.ATTENDANT_API_KEY || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "";

const CARDAPIOWEB_BASE_URL =
  process.env.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN || "";

// (Opcional) se você tiver o store/merchant id do Cardápio Web
const CARDAPIOWEB_STORE_ID = process.env.CARDAPIOWEB_STORE_ID || "";

// ===== In-memory store (temporário) =====
const ORDERS = new Map(); // orderId -> order
const SESSIONS = new Map(); // phone -> session state

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
    hasCardapioWebStoreId: Boolean(CARDAPIOWEB_STORE_ID),
  });
});

// ===== CARDAPIO WEB (helpers) =====
async function cardapioWebFetch(path, { method = "GET", body } = {}) {
  if (!CARDAPIOWEB_TOKEN) {
    throw new Error("CARDAPIOWEB_TOKEN não configurado no Render (Environment).");
  }
  const url = `${CARDAPIOWEB_BASE_URL}${path}`;

  const resp = await fetch(url, {
    method,
    headers: {
      "X-API-KEY": CARDAPIOWEB_TOKEN, // ✅ padrão Cardápio Web (conforme doc)
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

// ⚠️ Ajuste os paths abaixo conforme o Stoplight do Cardápio Web
// (eu deixei nomes “prováveis”, mas o Stoplight pode usar /catalogo ou /catalog etc.)

async function consultarCatalogoCardapioWeb() {
  // Se seu Stoplight mostrar outro path, troque aqui.
  // Exemplos comuns:
  //  - /catalog
  //  - /catalogo
  //  - /stores/:id/catalog
  //  - /merchants/:id/catalog
  if (CARDAPIOWEB_STORE_ID) {
    // tentativa 1: por loja
    try {
      return await cardapioWebFetch(`/stores/${encodeURIComponent(CARDAPIOWEB_STORE_ID)}/catalog`);
    } catch (_) {}
    // tentativa 2: outro padrão
    try {
      return await cardapioWebFetch(`/merchants/${encodeURIComponent(CARDAPIOWEB_STORE_ID)}/catalog`);
    } catch (_) {}
  }

  // fallback genérico
  // Troque para o endpoint exato do seu Stoplight (ex: /catalogo)
  return cardapioWebFetch(`/catalog`);
}

async function consultarPedidoCardapioWeb(orderId) {
  // Troque para o endpoint exato do Stoplight (ex: /orders/{id})
  return cardapioWebFetch(`/orders/${encodeURIComponent(orderId)}`);
}

// ===== WHATSAPP CLOUD (helpers) =====
async function sendWhatsAppText(toNumber, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurados.");
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

async function sendWhatsAppButtons(toNumber) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurados.");
  }

  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: String(toNumber).replace(/\D/g, ""),
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text:
          "Olá! 👋 Sou a atendente automática da *Pappi Pizza* 🍕\n" +
          "Escolha uma opção abaixo:",
      },
      action: {
        buttons: [
          { type: "reply", reply: { id: "MENU", title: "📖 Cardápio" } },
          { type: "reply", reply: { id: "TAKEOUT", title: "🏃 Retirada" } },
          { type: "reply", reply: { id: "DELIVERY", title: "🛵 Entrega" } },
        ],
      },
    },
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
      data?.error?.message || data?.message || `Erro ao enviar botões (${resp.status})`;
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
          interactive: m.interactive || null,
          raw: m,
        });
      }
    }
  }
  return out;
}

function getSession(phone) {
  if (!SESSIONS.has(phone)) {
    SESSIONS.set(phone, {
      step: "start",
      mode: null, // "delivery" | "takeout"
      address: { street: "", district: "", ref: "" },
    });
  }
  return SESSIONS.get(phone);
}

function resetSession(phone) {
  SESSIONS.set(phone, {
    step: "start",
    mode: null,
    address: { street: "", district: "", ref: "" },
  });
}

// ===== WEBHOOK WHATSAPP (Meta) =====

// 1) Verificação (GET) — “Verificar e salvar”
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
  // WhatsApp espera 200 rápido
  res.sendStatus(200);

  try {
    const msgs = extractIncomingMessages(req.body);

    for (const msg of msgs) {
      const phone = msg.from;
      const session = getSession(phone);

      // 1) Clique em botão (interactive)
      if (msg.type === "interactive") {
        const btnId = msg.raw?.interactive?.button_reply?.id;

        if (btnId === "MENU") {
          session.step = "start";
          await sendWhatsAppText(
            phone,
            "📖 Cardápio online:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony\n\n" +
              "Se quiser, diga: *retirada* ou *entrega*."
          );
          continue;
        }

        if (btnId === "TAKEOUT") {
          session.mode = "takeout";
          session.step = "takeout_order";
          await sendWhatsAppText(
            phone,
            "🏃 *Retirada*\nMe diga o que você quer pedir.\nEx: *1 Calabresa grande + 1 Coca 2L*"
          );
          continue;
        }

        if (btnId === "DELIVERY") {
          session.mode = "delivery";
          session.step = "delivery_address";
          await sendWhatsAppText(
            phone,
            "🛵 *Entrega*\nMe diga:\n1) Rua e nº\n2) Bairro\n3) Referência"
          );
          continue;
        }

        // se cair aqui, mostra botões de novo
        await sendWhatsAppButtons(phone);
        continue;
      }

      // 2) Texto normal
      const text = (msg.text || "").trim();
      if (!text) continue;

      const lower = text.toLowerCase();

      // comandos rápidos
      if (lower === "reiniciar" || lower === "reset") {
        resetSession(phone);
        await sendWhatsAppButtons(phone);
        continue;
      }

      if (lower.includes("menu") || lower.includes("cardápio") || lower.includes("cardapio")) {
        await sendWhatsAppText(phone, "📖 Cardápio:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony");
        continue;
      }

      if (lower.includes("retirada")) {
        session.mode = "takeout";
        session.step = "takeout_order";
        await sendWhatsAppText(
          phone,
          "🏃 *Retirada*\nMe diga o que você quer pedir.\nEx: *1 Calabresa grande + 1 Coca 2L*"
        );
        continue;
      }

      if (lower.includes("entrega")) {
        session.mode = "delivery";
        session.step = "delivery_address";
        await sendWhatsAppText(
          phone,
          "🛵 *Entrega*\nMe diga:\n1) Rua e nº\n2) Bairro\n3) Referência"
        );
        continue;
      }

      // consulta pedido: "pedido 7637462"
      const matchOrder = lower.match(/pedido\s*[:#-]?\s*([a-z0-9_-]+)/i);
      if (matchOrder && matchOrder[1]) {
        const orderId = matchOrder[1].trim();
        try {
          const order = await consultarPedidoCardapioWeb(orderId);
          const status = order?.status || "desconhecido";
          const total =
            order?.total != null ? `R$ ${Number(order.total).toFixed(2)}` : "—";
          const display =
            order?.display_id != null ? `#${order.display_id}` : orderId;

          await sendWhatsAppText(
            phone,
            `📦 *Pedido ${display}*\nStatus: *${status}*\nTotal: *${total}*`
          );
        } catch (err) {
          await sendWhatsAppText(
            phone,
            `Não consegui localizar o pedido *${orderId}* agora. 😕\nConfere se o ID está certo.`
          );
        }
        continue;
      }

      // catálogo “puxar itens” (debug pro seu time)
      if (lower === "catalogo" || lower === "catálogo") {
        try {
          const cat = await consultarCatalogoCardapioWeb();
          // aqui é só uma amostra pequena pra não spammar
          const preview = JSON.stringify(cat).slice(0, 900);
          await sendWhatsAppText(
            phone,
            "✅ Catálogo puxado da API (prévia):\n" + preview + "\n\n(Prévia curta)"
          );
        } catch (err) {
          await sendWhatsAppText(
            phone,
            `❌ Falha ao puxar catálogo.\nMotivo: ${err?.message || "erro"}`
          );
        }
        continue;
      }

      // fluxo por “estado” (sessão)
      if (session.step === "delivery_address") {
        // simples: salva tudo numa linha como endereço
        session.address.street = text;
        session.step = "delivery_order";
        await sendWhatsAppText(
          phone,
          "Perfeito ✅ Agora me diga o que você quer pedir.\nEx: *1 Calabresa grande + 1 Coca 2L*"
        );
        continue;
      }

      if (session.step === "delivery_order") {
        session.step = "done";
        await sendWhatsAppText(
          phone,
          "Fechado! ✅\n" +
            `📍 Endereço: ${session.address.street}\n` +
            `🛒 Pedido: ${text}\n\n` +
            "Agora me diga a forma de pagamento: *Pix* ou *Dinheiro* ou *Cartão*."
        );
        continue;
      }

      if (session.step === "takeout_order") {
        session.step = "done";
        await sendWhatsAppText(
          phone,
          "Fechado! ✅\n" +
            `🏃 Retirada\n` +
            `🛒 Pedido: ${text}\n\n` +
            "Agora me diga a forma de pagamento: *Pix* ou *Dinheiro* ou *Cartão*."
        );
        continue;
      }

      // fallback: sempre mostra botões
      await sendWhatsAppButtons(phone);
    }
  } catch (err) {
    console.error("Webhook error:", err?.message, err?.payload || "");
  }
});

// ===== PROTECTED (GPT Actions / atendentes) =====

// Criar pedido interno (seu sistema)
app.post("/orders", requireApiKey, (req, res) => {
  const body = req.body || {};

  if (!body.channel || !["site", "whatsapp"].includes(body.channel)) {
    return res.status(400).json({
      error: "BadRequest",
      message: "channel deve ser 'site' ou 'whatsapp'.",
    });
  }
  if (!body.customer?.name || !body.customer?.phone) {
    return res.status(400).json({
      error: "BadRequest",
      message: "customer.name e customer.phone são obrigatórios.",
    });
  }
  if (!Array.isArray(body.items) || body.items.length < 1) {
    return res.status(400).json({
      error: "BadRequest",
      message: "items deve ter pelo menos 1 item.",
    });
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
  if (!order) {
    return res.status(404).json({ error: "NotFound", message: "Pedido não encontrado." });
  }
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

// ===== RUN =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));

