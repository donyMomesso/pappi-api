const express = require("express");
const app = express();

app.use(express.json({ limit: "2mb" }));

/**
 * =========================
 * ENV / CONFIG
 * =========================
 */
const ATTENDANT_API_KEY = process.env.ATTENDANT_API_KEY;

// WhatsApp Cloud API (Meta)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

// Cardápio Web
const CARDAPIOWEB_BASE_URL = process.env.CARDAPIOWEB_BASE_URL; // ex: https://api.cardapioweb.com
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN;
const CARDAPIOWEB_STORE_ID = process.env.CARDAPIOWEB_STORE_ID;

// Caminho configurável (pra você ajustar sem mexer no código)
const CARDAPIOWEB_CREATE_ORDER_PATH =
  process.env.CARDAPIOWEB_CREATE_ORDER_PATH || "/stores/{storeId}/orders";

// Sua loja
const STORE_META = {
  storeName: "Pappi Pizza",
  menuUrl: "https://app.cardapioweb.com/pappi_pizza?s=dony",
  whatsappNumbers: ["+55 19 98319-3999", "+55 19 98227-5105"],
};

/**
 * =========================
 * HELPERS
 * =========================
 */
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
    return res.status(401).json({ error: "Unauthorized", message: "API Key inválida ou ausente" });
  }
  next();
}

async function httpJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

function normalizePhoneBR(phone) {
  // recebe "5511999999999" ou "+55 11 99999-9999"
  return (phone || "").replace(/\D/g, "");
}

/**
 * =========================
 * CARDÁPIO WEB - CREATE ORDER (direto)
 * =========================
 * Atenção: o endpoint real pode variar.
 * Por isso usamos CARDAPIOWEB_CREATE_ORDER_PATH com {storeId}.
 */
async function createOrderInCardapioWeb(orderPayload) {
  if (!CARDAPIOWEB_BASE_URL || !CARDAPIOWEB_TOKEN) {
    return {
      ok: false,
      reason: "CardapioWebNotConfigured",
      message: "CARDAPIOWEB_BASE_URL / CARDAPIOWEB_TOKEN não configurados no Render.",
    };
  }

  const path = CARDAPIOWEB_CREATE_ORDER_PATH.replace("{storeId}", CARDAPIOWEB_STORE_ID || "");
  const url = `${CARDAPIOWEB_BASE_URL}${path}`;

  // ajuste headers conforme doc do Cardápio Web (alguns usam Bearer, outros X-API-Key)
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${CARDAPIOWEB_TOKEN}`,
  };

  const data = await httpJson(url, {
    method: "POST",
    headers,
    body: JSON.stringify(orderPayload),
  });

  return { ok: true, data };
}

/**
 * =========================
 * WHATSAPP - SEND MESSAGE
 * =========================
 */
async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    return {
      ok: false,
      reason: "WhatsAppNotConfigured",
      message: "WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID não configurados no Render.",
    };
  }

  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: normalizePhoneBR(to),
    type: "text",
    text: { body: text },
  };

  const data = await httpJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return { ok: true, data };
}

/**
 * =========================
 * VERY SIMPLE ORDER PARSER (MVP)
 * =========================
 * Exemplo: "1 pizza calabresa grande + 1 coca 2l"
 * Aqui é simples. Depois a gente liga com catálogo real do Cardápio Web.
 */
function parseOrderFromText(text) {
  const t = (text || "").toLowerCase();

  // gatilhos rápidos
  if (t.includes("cardapio") || t.includes("cardápio")) {
    return { intent: "MENU" };
  }

  // MVP: detecta 1 pizza calabresa + 1 coca
  const items = [];
  if (t.includes("calabresa")) {
    items.push({ itemId: "pizza_calabresa", name: "Pizza Calabresa", quantity: 1, unitPrice: 59.9 });
  }
  if (t.includes("coca") && (t.includes("2l") || t.includes("2 l"))) {
    items.push({ itemId: "coca_2l", name: "Coca-Cola 2L", quantity: 1, unitPrice: 12.0 });
  }

  if (!items.length) return { intent: "UNKNOWN" };

  return {
    intent: "CREATE_ORDER",
    channel: "whatsapp",
    customer: null, // a gente vai montar com o número
    items,
  };
}

/**
 * =========================
 * PUBLIC
 * =========================
 */
app.get("/health", (req, res) => {
  res.json({ ok: true, app: "Pappi Pizza API", time: nowIso() });
});

app.get("/meta", (req, res) => {
  res.json(STORE_META);
});

app.get("/debug-auth", (req, res) => {
  const key = req.header("X-API-Key") || "";
  res.json({
    hasEnvAttendantKey: Boolean(ATTENDANT_API_KEY),
    attendantKeyLength: (ATTENDANT_API_KEY || "").length,
    hasHeaderKey: Boolean(key),
    headerKeyLength: key.length,
    hasWhatsappToken: Boolean(WHATSAPP_TOKEN),
    hasWhatsappPhoneNumberId: Boolean(WHATSAPP_PHONE_NUMBER_ID),
    hasWebhookVerifyToken: Boolean(WEBHOOK_VERIFY_TOKEN),
    cardapioweb: {
      hasBaseUrl: Boolean(CARDAPIOWEB_BASE_URL),
      hasToken: Boolean(CARDAPIOWEB_TOKEN),
      hasStoreId: Boolean(CARDAPIOWEB_STORE_ID),
      createOrderPath: CARDAPIOWEB_CREATE_ORDER_PATH,
    },
  });
});

/**
 * =========================
 * PROTECTED (atendentes)
 * =========================
 */
const ORDERS = new Map();

app.post("/orders", requireApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const orderId = "ord_" + Math.random().toString(36).slice(2, 10);

    const items = Array.isArray(body.items) ? body.items : [];
    const subtotal = items.reduce((acc, it) => acc + (it.quantity || 0) * (it.unitPrice || 0), 0);
    const deliveryFee = typeof body.deliveryFee === "number" ? body.deliveryFee : 0;
    const discount = typeof body.discount === "number" ? body.discount : 0;
    const total = Math.max(0, subtotal + deliveryFee - discount);

    const order = {
      id: orderId,
      status: "received",
      channel: body.channel || "whatsapp",
      customer: body.customer || {},
      items,
      totals: { subtotal, deliveryFee, discount, total },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    ORDERS.set(orderId, order);

    // Se quiser “criar direto” também no Cardápio Web
    let cardapioWebResult = null;
    if (body.syncCardapioWeb !== false) {
      // Você pode ajustar o payload aqui conforme o formato exigido pelo Cardápio Web
      const payloadToCardapioWeb = {
        // modelo genérico (ajuste depois de confirmar a doc)
        externalId: orderId,
        channel: order.channel,
        customer: order.customer,
        items: order.items,
        totals: order.totals,
        createdAt: order.createdAt,
      };

      try {
        cardapioWebResult = await createOrderInCardapioWeb(payloadToCardapioWeb);
      } catch (e) {
        cardapioWebResult = {
          ok: false,
          error: "CardapioWebError",
          status: e.status,
          data: e.data,
        };
      }
    }

    return res.status(201).json({ ...order, cardapioWeb: cardapioWebResult });
  } catch (e) {
    return res.status(500).json({ error: "ServerError", message: e.message });
  }
});

app.get("/orders", requireApiKey, (req, res) => {
  const arr = Array.from(ORDERS.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 30);
  res.json(arr);
});

app.get("/orders/:orderId", requireApiKey, (req, res) => {
  const order = ORDERS.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: "NotFound", message: "Pedido não encontrado." });
  res.json(order);
});

/**
 * =========================
 * WHATSAPP WEBHOOK
 * =========================
 * 1) Verificação (GET)
 * 2) Recebimento de mensagens (POST)
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && WEBHOOK_VERIFY_TOKEN && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // Responde 200 rápido pro Meta não re-tentar
    res.sendStatus(200);

    // Estrutura padrão do WhatsApp Cloud
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Mensagens recebidas
    const messages = value?.messages || [];
    if (!messages.length) return;

    for (const msg of messages) {
      const from = msg.from; // número do cliente
      const text = msg?.text?.body || "";

      const parsed = parseOrderFromText(text);

      if (parsed.intent === "MENU") {
        await sendWhatsAppText(from, `🍕 Cardápio Pappi Pizza:\n${STORE_META.menuUrl}\n\nMe diga o que você quer pedir 😉`);
        continue;
      }

      if (parsed.intent === "UNKNOWN") {
        await sendWhatsAppText(
          from,
          `Me fala assim: "1 pizza calabresa grande + 1 coca 2L"\nOu digite "cardápio" pra ver opções 😉`
        );
        continue;
      }

      if (parsed.intent === "CREATE_ORDER") {
        // Monta cliente
        const customer = {
          name: "Cliente WhatsApp",
          phone: from,
        };

        // Cria pedido DIRETO no Cardápio Web (ajuste o payload final conforme doc)
        const orderPayload = {
          channel: "whatsapp",
          customer,
          items: parsed.items,
          // opcional: endereço se o cliente mandar
        };

        let result;
        try {
          result = await createOrderInCardapioWeb(orderPayload);
        } catch (e) {
          result = { ok: false, status: e.status, data: e.data };
        }

        if (!result.ok) {
          await sendWhatsAppText(
            from,
            `⚠️ Não consegui registrar no sistema agora.\nMe confirma o pedido aqui mesmo e já te atendemos:\n\n${text}`
          );
          continue;
        }

        await sendWhatsAppText(
          from,
          `✅ Pedido registrado!\n\nAgora me envie o ENDEREÇO (rua, nº, bairro) e a forma de pagamento.`
        );
      }
    }
  } catch (e) {
    // Se der erro, não derruba webhook
    console.error("Webhook error:", e);
  }
});

/**
 * =========================
 * START
 * =========================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));
