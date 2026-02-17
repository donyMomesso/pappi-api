const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const { loadRulesFromFiles } = require("../rules/loader");

// ✅ ATENÇÃO: aqui é "serviços" (com acento) conforme seu print
const { getMode } = require("../serviços/context.service");
const { getUpsellHint } = require("../serviços/upsell.service");
const { quoteDeliveryIfPossible } = require("../serviços/deliveryQuote.service");

const router = express.Router();
const prisma = new PrismaClient();

const LINK_CARDAPIO = "https://pappipizza.cardapioweb.com";

// ===============================
// Anti-duplicação (WhatsApp pode reenviar)
// ===============================
const processedMsgIds = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processedMsgIds.has(id)) return true;
  processedMsgIds.add(id);
  if (processedMsgIds.size > 5000) processedMsgIds.clear();
  return false;
}

// ===============================
// Memória curta por telefone (últimas 10 falas)
// ===============================
const chatHistory = new Map();
function pushHistory(phone, role, text) {
  if (!chatHistory.has(phone)) chatHistory.set(phone, []);
  const h = chatHistory.get(phone);
  h.push({ role, text: String(text || "").slice(0, 900) });
  if (h.length > 10) h.splice(0, h.length - 10);
}
function getHistoryText(phone) {
  const h = chatHistory.get(phone) || [];
  return h.map((x) => (x.role === "user" ? `Cliente: ${x.text}` : `Atendente: ${x.text}`)).join("\n");
}

// ===============================
// IA (Gemini)
// ===============================
function getGeminiModel(preferred) {
  const apiKey = ENV.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada no Render.");

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = String(preferred || ENV.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");
  return genAI.getGenerativeModel({ model: modelName });
}

async function geminiGenerate(content) {
  const modelName = String(ENV.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");
  const model = getGeminiModel(modelName);
  const result = await model.generateContent(content);
  return result.response.text();
}

// ===============================
// HELPERS (WHATSAPP)
// ===============================
function digitsOnly(str) {
  return String(str || "").replace(/\D/g, "");
}

async function waSend(payload) {
  if (!ENV.WHATSAPP_TOKEN || !ENV.WHATSAPP_PHONE_NUMBER_ID) {
    console.error("❌ WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurado.");
    return;
  }

  const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }).catch((e) => console.error("❌ Erro WA API:", e));
}

async function sendText(to, text) {
  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "text",
    text: { body: String(text || "").slice(0, 3500) },
  });
}

// ===============================
// ÁUDIO: baixar do WhatsApp
// ===============================
async function downloadAudio(mediaId) {
  try {
    if (!ENV.WHATSAPP_TOKEN) return null;

    const metaResp = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` },
    });

    const meta = await metaResp.json();
    const url = meta?.url;
    if (!url) return null;

    const mediaResp = await fetch(url, {
      headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` },
    });

    const mimeType = mediaResp.headers.get("content-type") || "audio/ogg";
    const buffer = await mediaResp.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    return { base64, mimeType };
  } catch (e) {
    console.error("❌ downloadAudio erro:", e?.message || e);
    return null;
  }
}

// ===============================
// ÁUDIO: transcrever + extrair JSON
// ===============================
async function transcribeAndExtractOrderFromAudio(base64, mimeType) {
  const PROMPT_AUDIO = `
Você é o atendente da Pappi Pizza.
Tarefa: TRANSCRAVA o áudio do cliente e EXTRAIA dados do pedido.

Responda SOMENTE em JSON válido (sem texto fora do JSON):
{
  "transcription": "...",
  "size_slices": 4|8|16|null,
  "is_half_half": true|false|null,
  "flavors": ["...","..."],
  "wants_menu": true|false|null,
  "delivery_or_pickup": "entrega"|"retirada"|null,
  "address_text": "..."|null,
  "customer_name": "..."|null
}

Regras:
- Não invente.
- Se falar "meio a meio", is_half_half=true.
- "16/gigante" => 16; "8/grande" => 8; "4/brotinho" => 4.
- Se pedir "sabores/cardápio", wants_menu=true.
- Se falar entrega/retirada, preencha delivery_or_pickup.
- Se no áudio tiver rua+número+bairro, preencha address_text.
- Se ele disser o nome (ex: "aqui é o Dony"), preencha customer_name.
`.trim();

  const content = [
    { text: PROMPT_AUDIO },
    { inlineData: { data: base64, mimeType: mimeType || "audio/ogg" } },
  ];

  const raw = await geminiGenerate(content);

  try {
    const clean = String(raw || "")
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    return JSON.parse(clean);
  } catch {
    return {
      transcription: String(raw || "").trim(),
      size_slices: null,
      is_half_half: null,
      flavors: [],
      wants_menu: null,
      delivery_or_pickup: null,
      address_text: null,
      customer_name: null,
    };
  }
}

// ===============================
// CARDAPIOWEB
// ===============================
async function getMenu() {
  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
  const url = `${base}/api/partner/v1/catalog`;

  try {
    const resp = await fetch(url, {
      headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, Accept: "application/json" },
    });

    const data = await resp.json();
    if (!data?.categories) return "Cardápio indisponível no momento.";

    let txt = "🍕 MENU PAPPI PIZZA:\n";
    data.categories.forEach((cat) => {
      if (cat?.status === "ACTIVE") {
        txt += `\n${String(cat.name || "CATEGORIA").toUpperCase()}\n`;
        (cat.items || []).forEach((i) => {
          if (i?.status === "ACTIVE") {
            const price = Number(i.price);
            const priceTxt = Number.isFinite(price) ? price.toFixed(2) : "0.00";
            txt += `- ${i.name} (R$ ${priceTxt})\n`;
          }
        });
      }
    });

    return txt.trim();
  } catch (e) {
    console.error("❌ getMenu erro:", e?.message || e);
    return "Cardápio indisponível no momento.";
  }
}

async function getMerchant() {
  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
  const url = `${base}/api/partner/v1/merchant`;

  try {
    const resp = await fetch(url, {
      headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, Accept: "application/json" },
    });
    return await resp.json();
  } catch (e) {
    console.error("❌ getMerchant erro:", e?.message || e);
    return null;
  }
}

function normalizePayments(merchant) {
  const raw =
    merchant?.métodos_de_pagamento ||
    merchant?.metodos_de_pagamento ||
    merchant?.payment_methods ||
    merchant?.payments ||
    null;

  if (!Array.isArray(raw)) return "PIX, Cartão e Dinheiro (confirmar)";

  const names = raw
    .filter((p) => p && (p.ativo === true || p.active === true || p.enabled === true || p.status === "ACTIVE"))
    .map((p) => p?.método_de_pagamento || p?.metodo_de_pagamento || p?.name || p?.method || p?.type)
    .filter(Boolean);

  return names.length ? names.join(", ") : "PIX, Cartão e Dinheiro (confirmar)";
}

function normalizeAddress(merchant) {
  const addr = merchant?.endereço || merchant?.endereco || merchant?.address || null;
  if (!addr) return "Campinas-SP (confirmar endereço da loja)";

  const rua = addr?.rua || addr?.street || "";
  const numero = addr?.número || addr?.numero || addr?.number || "";
  const bairro = addr?.bairro || addr?.district || "";

  const parts = [rua, numero, bairro].filter(Boolean).join(", ");
  return parts || "Campinas-SP (confirmar endereço da loja)";
}

// ===============================
// Rotas básicas
// ===============================
router.get("/", (req, res) => res.send("Pappi API IA online 🧠✅"));
router.get("/health", (req, res) => res.json({ ok: true, app: "Pappi Pizza IA" }));

// ===============================
// WEBHOOK PRINCIPAL
// ===============================
router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;
  if (alreadyProcessed(msg.id)) return;

  const from = msg.from;

  try {
    // CUSTOMER: cria se não existir
    let customer = await prisma.customer.findUnique({ where: { phone: from } }).catch(() => null);
    if (!customer) {
      customer = await prisma.customer.create({ data: { phone: from } });
    }

    // Entrada (texto ou áudio)
    let userText = "";
    let extracted = null;

    if (msg.type === "audio") {
      const audio = await downloadAudio(msg.audio?.id);
      if (!audio?.base64) {
        await sendText(from, "Puxa, não consegui ouvir esse áudio 😕 Pode escrever pra mim?");
        return;
      }

      extracted = await transcribeAndExtractOrderFromAudio(audio.base64, audio.mimeType);
      userText = `ÁUDIO TRANSCRITO: ${extracted.transcription || ""}`.trim();

      const extras = [];
      if (extracted.size_slices) extras.push(`Tamanho detectado: ${extracted.size_slices} fatias`);
      if (extracted.is_half_half === true) extras.push(`Pedido: meio a meio`);
      if (Array.isArray(extracted.flavors) && extracted.flavors.length) extras.push(`Sabores: ${extracted.flavors.join(" e ")}`);
      if (extracted.wants_menu === true) extras.push(`Cliente pediu: cardápio/sabores`);
      if (extracted.delivery_or_pickup) extras.push(`Entrega/Retirada: ${extracted.delivery_or_pickup}`);
      if (extracted.address_text) extras.push(`Endereço citado: ${extracted.address_text}`);
      if (extracted.customer_name) extras.push(`Nome citado: ${extracted.customer_name}`);

      if (extras.length) userText += `\nDADOS EXTRAÍDOS: ${extras.join(" | ")}`;
    } else {
      userText = msg.text?.body || "";
      if (!userText) return;
    }

    // Atualiza lastInteraction sempre que chega msg
    await prisma.customer
      .update({
        where: { phone: from },
        data: { lastInteraction: new Date() },
      })
      .catch(() => null);

    // Se o áudio trouxe nome, salva (apenas se ainda não tiver)
    if (extracted?.customer_name && !customer?.name) {
      const nm = String(extracted.customer_name).trim().slice(0, 60);
      if (nm.length >= 2) {
        customer = await prisma.customer
          .update({
            where: { phone: from },
            data: { name: nm },
          })
          .catch(() => customer);
      }
    }

    // Histórico curto
    pushHistory(from, "user", userText);

    // Dados loja
    const [menu, merchant, configPix] = await Promise.all([
      getMenu(),
      getMerchant(),
      prisma.config.findUnique({ where: { key: "CHAVE_PIX" } }).catch(() => null),
    ]);

    const pagamentos = normalizePayments(merchant);
    const enderecoLoja = normalizeAddress(merchant);
    const pix = configPix?.value || "PIX: 19 9 8319 3999 - Darclee Duran";

    // MODO (interno)
