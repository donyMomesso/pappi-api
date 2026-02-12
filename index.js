/**
 * Pappi API - WhatsApp Cloud + Cardápio Web + Health/Debug
 * Node 18+ (fetch nativo)
 */

const express = require("express");
const app = express();

// Body parser
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

// ===== CARDÁPIO WEB FETCH =====
async function cardapioWebFetch(path, { method = "GET", body } = {}) {
  if (!CARDAPIOWEB_TOKEN) {
    throw new Error("CARDAPIOWEB_TOKEN não configurado no Render (Environment).");
  }

  const url = `${CARDAPIOWEB_BASE_URL}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      "X-API-KEY": CARDAPIOWEB_TOKEN, // padrão Cardápio Web
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

// Exemplo do endpoint que você mandou (produção/sandbox muda só o base_url)
async function consultarCatalogo() {
  // ✅ conforme seu print: /api/partner/v1/catalog
  return cardapioWebFetch("/api/partner/v1/catalog");
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

// =====✅ ROTAS DE STATUS (COLEI AQUI DO JEITO CERTO) =====
app.get("/", (req, res) => {
  res.status(200).send("Pappi API online ✅");
});

app.get("/health", (req, res) => {
  res
    .status(200)
    .json({ ok: true, app: "Pappi Pizza API", time: nowIso() });
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

// ===== TESTE: puxar catálogo direto (pra você validar) =====
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

// ===== WEBHOOK WHATSAPP =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  // Responde rápido pra Meta
  res.sendStatus(200);

  try {
    const msgs = extractIncomingMessages(req.body);

    for (const msg of msgs) {
      const text = (msg.text || "").trim();
      if (!text) continue;

      const lower = text.toLowerCase();

      if (lower === "menu" || lower === "cardapio" || lower === "cardápio") {
        await sendWhatsAppText(
          msg.from,
          `🍕 *Pappi Pizza* — Cardápio:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony\n\nQuer pedir? Me diga: *sabor + tamanho* (ex: Calabresa grande).`
        );
        continue;
      }

      // Exemplo simples: responde eco + instrução
      await sendWhatsAppText(
        msg.from,
        `Recebi: "${text}" ✅\n\nDigite *menu* para ver o cardápio.`
      );
    }
  } catch (err) {
    console.error("Webhook error:", err?.message, err?.payload || "");
  }
});

// ===== ROTAS PROTEGIDAS (GPT Actions / atendentes) =====
app.get("/orders", requireApiKey, (req, res) => {
  res.json({ ok: true, message: "endpoint de pedidos interno (coloque sua lógica aqui)" });
});

// ===== RUN =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));
