const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { loadRules } = require("../rules/loader");

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
// IA (Gemini) - modelo via ENV + fallback
// ===============================
function getGeminiModel(preferred) {
  const apiKey = ENV.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada no Render.");

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = String(preferred || ENV.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");
  return genAI.getGenerativeModel({ model: modelName });
}

async function geminiGenerate(content) {
  const primary = String(ENV.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");
  const fallback = "gemini-2.5-flash";

  try {
    console.log("🤖 Gemini model (primary):", primary);
    const model = getGeminiModel(primary);
    const result = await model.generateContent(content);
    return result.response.text();
  } catch (e) {
    console.error("⚠️ Gemini falhou no primary:", primary, e?.status || e?.message);
    console.log("🤖 Gemini model (fallback):", fallback);
    const model = getGeminiModel(fallback);
    const result = await model.generateContent(content);
    return result.response.text();
  }
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
// ÁUDIO: baixar arquivo do WhatsApp
// ===============================
async function downloadAudio(mediaId) {
  try {
    if (!ENV.WHATSAPP_TOKEN) return null;

    // 1) pega URL do media
    const metaResp = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` },
    });
    const meta = await metaResp.json();
    const url = meta?.url;
    if (!url) return null;

    // 2) baixa o binário
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

// ✅ ÁUDIO: transcrever + extrair pedido (JSON)
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
  "wants_menu": true|false|null
}

Regras:
- Não invente sabores. Só coloque sabores que o cliente falou claramente.
- Se o cliente falar "meio a meio", is_half_half = true (mesmo sem falar sabores).
- Se falar "16" ou "gigante", size_slices = 16. Se falar "8/grande" => 8. "4/brotinho" => 4.
- Se o cliente pedir "sabores/cardápio", wants_menu = true.
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
    return { transcription: String(raw || "").trim(), size_slices: null, is_half_half: null, flavors: [], wants_menu: null };
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

    let txt = "🍕 *MENU PAPPI PIZZA:*\n";
    data.categories.forEach((cat) => {
      if (cat?.status === "ACTIVE") {
        txt += `\n*${String(cat.name || "CATEGORIA").toUpperCase()}*\n`;
        (cat.items || []).forEach((i) => {
          if (i?.status === "ACTIVE") {
            const price = Number(i.price);
            const priceTxt = Number.isFinite(price) ? price.toFixed(2) : "0.00";
            txt += `- ${i.name}: R$ ${priceTxt}\n`;
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
// WEBHOOK PRINCIPAL (WhatsApp)
// ===============================
router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;
  if (alreadyProcessed(msg.id)) return;

  const from = msg.from;

  try {
    let userText = "";

    // 1) Entrada (texto ou áudio)
    if (msg.type === "audio") {
      const audio = await downloadAudio(msg.audio?.id);
      if (!audio?.base64) {
        await sendText(from, "Puxa, não consegui ouvir esse áudio 😕 Pode escrever pra mim?");
        return;
      }

      const info = await transcribeAndExtractOrderFromAudio(audio.base64, audio.mimeType);

      userText = `ÁUDIO TRANSCRITO: ${info.transcription || ""}`.trim();

      const extras = [];
      if (info.size_slices) extras.push(`Tamanho detectado: ${info.size_slices} fatias`);
      if (info.is_half_half === true) extras.push(`Pedido: meio a meio`);
      if (Array.isArray(info.flavors) && info.flavors.length) extras.push(`Sabores: ${info.flavors.join(" e ")}`);
      if (info.wants_menu === true) extras.push(`Cliente pediu: cardápio/sabores`);

      if (extras.length) userText += `\nDADOS EXTRAÍDOS: ${extras.join(" | ")}`;
    } else {
      userText = msg.text?.body || "";
      if (!userText) return;
    }

    // 2) Salva histórico do cliente
    pushHistory(from, "user", userText);

    // 3) Busca dados (menu/merchant/pix)
    const [menu, merchant, configPix] = await Promise.all([
      getMenu(),
      getMerchant(),
      prisma.config.findUnique({ where: { key: "CHAVE_PIX" } }).catch(() => null),
    ]);

    const pagamentos = normalizePayments(merchant);
    const enderecoLoja = normalizeAddress(merchant);
    const pix = configPix?.value || "PIX: 19 9 8319 3999 - Darclee Duran";

    const RULES = loadRules();
    const historyText = getHistoryText(from);

    // 4) Prompt central (regras + dados + menu + histórico)
    const PROMPT = `
Você é o atendente virtual da Pappi Pizza (Campinas-SP).

Siga rigorosamente as regras abaixo:
${RULES}

DADOS DA LOJA:
- Endereço: ${enderecoLoja}
- Pagamentos: ${pagamentos}
- PIX: ${pix}
- Cardápio online: ${LINK_CARDAPIO}

CARDÁPIO (use quando o cliente pedir sabores/valores):
${menu}

HISTÓRICO DA CONVERSA (use para NÃO repetir perguntas):
${historyText}
`.trim();

    // 5) Monta conteúdo
    const content = `${PROMPT}\n\nCliente: ${userText}\nAtendente:`;

    // 6) Gera e envia
    const resposta = await geminiGenerate(content);

    // 7) Salva histórico do bot
    pushHistory(from, "assistant", resposta);

    await sendText(from, resposta);
  } catch (error) {
    console.error("🔥 Erro:", error);
    await sendText(
      from,
      `Tive uma instabilidade rapidinha 😅🍕\nMe manda de novo: seu pedido + se é entrega ou retirada.\nSe preferir, peça aqui:\n${LINK_CARDAPIO}`
    );
  }
});

module.exports = router;
