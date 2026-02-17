const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const { loadRulesFromFiles } = require("../rules/loader");
const { getMode } = require("../services/context.service");
const { getUpsellHint } = require("../services/upsell.service");

const router = express.Router();
const prisma = new PrismaClient();

const LINK_CARDAPIO = "https://pappipizza.cardapioweb.com";

// Anti-duplicação
const processedMsgIds = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processedMsgIds.has(id)) return true;
  processedMsgIds.add(id);
  if (processedMsgIds.size > 5000) processedMsgIds.clear();
  return false;
}

// Memória curta
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

// Gemini
function getGeminiModel(preferred) {
  const apiKey = ENV.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada no Render.");

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = String(preferred || ENV.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");
  return genAI.getGenerativeModel({ model: modelName });
}
async function geminiGenerate(content) {
  const primary = String(ENV.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");
  const model = getGeminiModel(primary);
  const result = await model.generateContent(content);
  return result.response.text();
}

// WhatsApp
function digitsOnly(str) {
  return String(str || "").replace(/\D/g, "");
}
async function waSend(payload) {
  if (!ENV.WHATSAPP_TOKEN || !ENV.WHATSAPP_PHONE_NUMBER_ID) return;
  const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
async function sendText(to, text) {
  return waSend({ messaging_product: "whatsapp", to: digitsOnly(to), type: "text", text: { body: String(text || "").slice(0, 3500) } });
}

// Audio download
async function downloadAudio(mediaId) {
  try {
    const metaResp = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, { headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` } });
    const meta = await metaResp.json();
    if (!meta?.url) return null;

    const mediaResp = await fetch(meta.url, { headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` } });
    const mimeType = mediaResp.headers.get("content-type") || "audio/ogg";
    const buffer = await mediaResp.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return { base64, mimeType };
  } catch {
    return null;
  }
}

// Audio -> JSON extract
async function transcribeAndExtractOrderFromAudio(base64, mimeType) {
  const PROMPT_AUDIO = `
Responda SOMENTE em JSON válido:
{
 "transcription":"...",
 "size_slices":4|8|16|null,
 "is_half_half":true|false|null,
 "flavors":["...","..."],
 "wants_menu":true|false|null
}
`.trim();

  const content = [{ text: PROMPT_AUDIO }, { inlineData: { data: base64, mimeType: mimeType || "audio/ogg" } }];
  const raw = await geminiGenerate(content);

  try {
    const clean = String(raw || "").replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    return JSON.parse(clean);
  } catch {
    return { transcription: String(raw || "").trim(), size_slices: null, is_half_half: null, flavors: [], wants_menu: null };
  }
}

// Cardapio
async function getMenu() {
  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
  const url = `${base}/api/partner/v1/catalog`;
  try {
    const resp = await fetch(url, { headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, Accept: "application/json" } });
    const data = await resp.json();
    if (!data?.categories) return "Cardápio indisponível no momento.";
    let txt = "🍕 MENU:\n";
    data.categories.forEach((cat) => {
      if (cat?.status === "ACTIVE") {
        txt += `\n${String(cat.name || "").toUpperCase()}\n`;
        (cat.items || []).forEach((i) => {
          if (i?.status === "ACTIVE") txt += `- ${i.name}\n`;
        });
      }
    });
    return txt.trim();
  } catch {
    return "Cardápio indisponível no momento.";
  }
}
async function getMerchant() {
  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
  const url = `${base}/api/partner/v1/merchant`;
  try {
    const resp = await fetch(url, { headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, Accept: "application/json" } });
    return await resp.json();
  } catch {
    return null;
  }
}
function normalizePayments(merchant) {
  const raw = merchant?.metodos_de_pagamento || merchant?.métodos_de_pagamento || null;
  if (!Array.isArray(raw)) return "PIX, Cartão e Dinheiro (confirmar)";
  const names = raw.filter((p) => p?.ativo === true).map((p) => p?.metodo_de_pagamento || p?.método_de_pagamento).filter(Boolean);
  return names.length ? names.join(", ") : "PIX, Cartão e Dinheiro (confirmar)";
}
function normalizeAddress(merchant) {
  const addr = merchant?.endereco || merchant?.endereço || null;
  if (!addr) return "Campinas-SP";
  return [addr?.rua, addr?.numero || addr?.número, addr?.bairro].filter(Boolean).join(", ") || "Campinas-SP";
}

// Routes
router.get("/", (req, res) => res.send("Pappi API IA online 🧠✅"));
router.get("/health", (req, res) => res.json({ ok: true }));

router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;
  if (alreadyProcessed(msg.id)) return;

  const from = msg.from;

  try {
    // Customer
    let customer = await prisma.customer.findUnique({ where: { phone: from } }).catch(() => null);
    if (!customer) customer = await prisma.customer.create({ data: { phone: from, totalOrders: 0 } }).catch(() => ({ phone: from, totalOrders: 0 }));
    await prisma.customer.update({ where: { phone: from }, data: { lastInteraction: new Date() } }).catch(() => null);

    const mode = getMode({ customer, now: new Date() });

    // Entrada
    let userText = "";
    if (msg.type === "audio") {
      const audio = await downloadAudio(msg.audio?.id);
      if (!audio?.base64) return sendText(from, "Não consegui ouvir 😕 Pode escrever?");
      const info = await transcribeAndExtractOrderFromAudio(audio.base64, audio.mimeType);
      userText = `ÁUDIO: ${info.transcription || ""}`;
      const extras = [];
      if (info.size_slices) extras.push(`tamanho=${info.size_slices}`);
      if (info.is_half_half) extras.push(`meio_a_meio=true`);
      if (info.flavors?.length) extras.push(`sabores=${info.flavors.join(" e ")}`);
      if (extras.length) userText += `\nEXTRA: ${extras.join(" | ")}`;
    } else {
      userText = msg.text?.body || "";
      if (!userText) return;
    }

    pushHistory(from, "user", userText);

    const [menu, merchant, configPix] = await Promise.all([
      getMenu(),
      getMerchant(),
      prisma.config.findUnique({ where: { key: "CHAVE_PIX" } }).catch(() => null),
    ]);

    const pagamentos = normalizePayments(merchant);
    const enderecoLoja = normalizeAddress(merchant);
    const pix = configPix?.value || "PIX: 19 9 8319 3999 - Darclee Duran";

    const historyText = getHistoryText(from);
    const RULES = loadRulesFromFiles(mode);
    const upsell = getUpsellHint({ historyText, userText });

    const PROMPT = `
Você é o atendente virtual da Pappi Pizza (Campinas-SP).

MODO ATUAL: ${mode}

REGRAS:
${RULES}

DADOS:
- Endereço: ${enderecoLoja}
- Pagamentos: ${pagamentos}
- PIX: ${pix}
- Cardápio online: ${LINK_CARDAPIO}

MENU:
${menu}

HISTÓRICO:
${historyText}

UPSELL (no máximo 1):
${upsell || "NENHUM"}
`.trim();

    const resposta = await geminiGenerate(`${PROMPT}\n\nCliente: ${userText}\nAtendente:`);

    pushHistory(from, "assistant", resposta);
    await sendText(from, resposta);
  } catch (e) {
    console.error("🔥 Erro:", e);
    await sendText(from, `Tive uma instabilidade 😅🍕\nMe diga: pedido + entrega/retirada.\n${LINK_CARDAPIO}`);
  }
});

module.exports = router;
