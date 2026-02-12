/**
 * Pappi API - WhatsApp Cloud + Cardápio Web + Botões + Health/Debug
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

// ===== HELPERS =====
function nowIso() {
  return new Date().toISOString();
}

function requireApiKey(req, res, next) {
  const key = req.header("X-API-Key");
  if (!API_KEY) {
    return res.status(500).json({
      error: "ServerMisconfigured",
      message: "ATTENDANT_API_KEY não configurada no Render (Environment).",
    });
  }
  if (!key || key !== API_KEY) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "API Key inválida ou ausente",
    });
  }
  next();
}

// ===== CARDÁPIO WEB =====
async function cardapioWebFetch(path, { method = "GET", body } = {}) {
  if (!CARDAPIOWEB_TOKEN) {
    throw new Error("CARDAPIOWEB_TOKEN não configurado no Render (Environment).");
  }

  const url = `${CARDAPIOWEB_BASE_URL}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      "X-API-KEY": CARDAPIOWEB_TOKEN,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    const err = new Error(data?.message || data?.error || "Erro Cardápio Web");
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function consultarCatalogo() {
  // Conforme seu print: GET /api/partner/v1/catalog
  return cardapioWebFetch("/api/partner/v1/catalog");
}

async function getTopPizzasFromCatalog(limit = 6) {
  const catalog = await consultarCatalogo();
  const cats = catalog?.categories || [];
  const pizzaCat =
    cats.find((c) => (c.name || "").toLowerCase().includes("pizza")) || cats[0];

  const items = (pizzaCat?.items || [])
    .filter((i) => i?.status === "ACTIVE")
    .slice(0, limit);

  return { categoryName: pizzaCat?.name || "Cardápio", items };
}

// ===== WHATSAPP CLOUD =====
async function sendWhatsAppText(toNumber, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurados.");
  }

  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

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
    const err = new Error(data?.error?.message || "Erro ao enviar WhatsApp");
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function sendWhatsAppButtons(toNumber, bodyText, buttons) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurados.");
  }

  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: String(toNumber).replace(/\D/g, ""),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
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
    const err = new Error(data?.error?.message || "Erro ao enviar botões");
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
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
        if (m.type === "text") {
          out.push({
            from: m.from,
            type: "text",
            text: m.text?.body || "",
          });
        }

        if (m.type === "interactive") {
          out.push({
            from: m.from,
            type: "button",
            text: m.interactive?.button_reply?.title || "",
            buttonId: m.interactive?.button_reply?.id || "",
          });
        }
      }
    }
  }
  return out;
}

// ===== STATUS ROUTES =====
app.get("/", (req, res) => res.status(200).send("Pappi API online ✅"));

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, app: "API da Pappi Pizza", time: nowIso() });
});

app.get("/debug-auth", (req, res) => {
  const headerKey = req.header("X-API-Key") || "";
  res.status(200).json({
    ok: true,
    hasEnvAttendantKey: Boolean(process.env.ATTENDANT_API_KEY),
    attendantKeyLength: (process.env.ATTENDANT_API_KEY || "").length,
    hasHeaderKey: Boolean(headerKey),
    headerKeyLength: headerKey.length,

    hasWhatsappToken: Boolean(WHATSAPP_TOKEN),
    hasWhatsappPhoneNumberId: Boolean(WHATSAPP_PHONE_NUMBER_ID),
    hasWebhookVerifyToken: Boolean(WEBHOOK_VERIFY_TOKEN),

    cardapioWebBaseUrl: CARDAPIOWEB_BASE_URL,
    hasCardapioWebToken: Boolean(CARDAPIOWEB_TOKEN),
  });
});

app.get("/catalog", async (req, res) => {
  try {
    const catalog = await consultarCatalogo();
    res.json(catalog);
  } catch (err) {
    res.status(err.status || 500).json({
      error: "CatalogError",
      message: err.message,
      status: err.status || 500,
      payload: err.payload || null,
    });
  }
});

// ===== WEBHOOK (Meta verification) =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== WEBHOOK (receive messages) =====
app.post("/webhook", async (req, res) => {
  // Meta quer 200 rápido
  res.sendStatus(200);

  try {
    const msgs = extractIncomingMessages(req.body);

    for (const msg of msgs) {
      // ===== clique em botões =====
      if (msg.type === "button") {
        if (msg.buttonId === "BTN_MENU") {
          await sendWhatsAppText(
            msg.from,
            "📖 Cardápio: https://app.cardapioweb.com/pappi_pizza?s=dony"
          );
          continue;
        }

        if (msg.buttonId === "BTN_PEDIR") {
          await sendWhatsAppButtons(
            msg.from,
            "Perfeito! É *entrega* ou *retirada*?",
            [
              { id: "BTN_ENTREGA", title: "🛵 Entrega" },
              { id: "BTN_RETIRADA", title: "🏃 Retirada" },
            ]
          );
          continue;
        }

        if (msg.buttonId === "BTN_ENTREGA") {
          await sendWhatsAppText(
            msg.from,
            "🛵 *Entrega*\nMe mande:\n1) Rua e nº\n2) Bairro\n3) Referência\n\nDepois me diga o pedido (ex: *Calabresa grande*)."
          );
          continue;
        }

        if (msg.buttonId === "BTN_RETIRADA") {
          await sendWhatsAppText(
            msg.from,
            "🏃 *Retirada*\nMe diga o pedido (ex: *Calabresa grande*).\n📍 Depois te passo o tempo de preparo."
          );
          continue;
        }

        if (msg.buttonId === "BTN_ATENDENTE") {
          await sendWhatsAppText(
            msg.from,
            "👩‍🍳 Certo! Já vou chamar uma atendente pra te ajudar ✅"
          );
          continue;
        }
      }

      // ===== texto normal =====
      const text = (msg.text || "").trim();
      if (!text) continue;

      const lower = text.toLowerCase();

      // "menu/cardapio"
      if (lower === "menu" || lower === "cardapio" || lower === "cardápio") {
        await sendWhatsAppText(
          msg.from,
          "📖 Cardápio: https://app.cardapioweb.com/pappi_pizza?s=dony"
        );
        continue;
      }

      // "promocao"
      if (lower.includes("promo") || lower.includes("promoção") || lower.includes("promocao")) {
        await sendWhatsAppText(
          msg.from,
          "🔥 Promoções variam por dia e horário.\nMe diga: *retirada* ou *entrega* + o que você quer (ex: Calabresa grande) que eu te confirmo certinho ✅"
        );
        continue;
      }

      // Se escrever "pizzas" mostra alguns itens do catálogo
      if (lower.includes("pizzas")) {
        try {
          const top = await getTopPizzasFromCatalog(6);
          const lines = top.items.map((i) => `• ${i.name}`).join("\n");
          await sendWhatsAppText(
            msg.from,
            `🍕 *${top.categoryName}*\n${lines}\n\nMe diga: *sabor + tamanho* (ex: Calabresa grande).`
          );
        } catch {
          await sendWhatsAppText(
            msg.from,
            "Não consegui carregar o catálogo agora 😕\nPode pedir direto dizendo: *Calabresa grande*."
          );
        }
        continue;
      }

      // ===== mensagem inicial padrão com botões =====
      await sendWhatsAppButtons(
        msg.from,
        "🍕 *Pappi Pizza*\nComo posso te ajudar?",
        [
          { id: "BTN_MENU", title: "📖 Cardápio" },
          { id: "BTN_PEDIR", title: "🛒 Fazer pedido" },
          { id: "BTN_ATENDENTE", title: "👩‍🍳 Atendente" },
        ]
      );
    }
  } catch (err) {
    console.error("Webhook error:", err?.message, err?.payload || "");
  }
});

// ===== PROTECTED (se quiser usar com GPT Actions) =====
app.get("/orders", requireApiKey, (req, res) => {
  res.json({ ok: true, message: "endpoint interno /orders (adicione sua lógica)" });
});

// ===== RUN =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));
