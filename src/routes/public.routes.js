const { loadRules } = require("../rules/loader");
const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const router = express.Router();
const prisma = new PrismaClient();

const LINK_CARDAPIO = "https://pappipizza.cardapioweb.com";

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
// HELPERS (WHATSAPP & ÁUDIO)
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

async function downloadAudio(mediaId) {
  try {
    if (!ENV.WHATSAPP_TOKEN) return null;

    const urlResp = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` },
    });

    const meta = await urlResp.json();
    const url = meta?.url;
    if (!url) return null;

    const media = await fetch(url, {
      headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` },
    });

    const buffer = await media.arrayBuffer();
    return Buffer.from(buffer).toString("base64");
  } catch (e) {
    console.error("❌ downloadAudio erro:", e?.message || e);
    return null;
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

router.get("/modelos-disponiveis", async (req, res) => {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${ENV.GEMINI_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// ===============================
// WEBHOOK PRINCIPAL
// ===============================
router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;

  const from = msg.from;

  try {
    // Entrada (texto ou áudio)
    let userText = "";
    let aiParts = null;

    if (msg.type === "audio") {
      const base64 = await downloadAudio(msg.audio?.id);
      if (!base64) {
        await sendText(from, "Puxa, não consegui ouvir esse áudio 😕 Pode escrever pra mim?");
        return;
      }

      aiParts = [
        { inlineData: { data: base64, mimeType: "audio/ogg" } },
        { text: "O cliente mandou um áudio. Transcreva e responda como atendente da Pappi Pizza." },
      ];
    } else {
      userText = msg.text?.body || "";
      if (!userText) return;
    }

    // Busca dados
    const [menu, merchant, configPix] = await Promise.all([
      getMenu(),
      getMerchant(),
      prisma.config.findUnique({ where: { key: "CHAVE_PIX" } }).catch(() => null),
    ]);

    const pagamentos = normalizePayments(merchant);
    const enderecoLoja = normalizeAddress(merchant);
    const pix = configPix?.value || "PIX: 19 9 8319 3999 - Darclee Duran";

    const PROMPT = `
Você é o atendente virtual da Pappi Pizza (Campinas-SP).
Seja rápido, simpático e objetivo. Use emojis moderadamente.

REGRAS:
- Se o cliente pedir pizza, pergunte tamanho: Brotinho (4), Grande (8) ou Gigante (16), se ele não falou.
- Se o cliente mandar endereço incompleto, peça Rua + Número + Bairro.
- Se o cliente pedir “promoção”, sugira 2 opções do cardápio que estão saindo muito hoje.
- Sempre finalize perguntando: "Posso confirmar e mandar pra cozinha?"

DADOS DA LOJA:
- Endereço da loja: ${enderecoLoja}
- Formas de pagamento: ${pagamentos}
- PIX: ${pix}
- Cardápio online: ${LINK_CARDAPIO}

CARDÁPIO (resumo):
${menu}
`.trim();

    // Monta conteúdo
    const content = aiParts
      ? [{ text: PROMPT }, ...aiParts]
      : `${PROMPT}\n\nCliente: ${userText}\nAtendente:`;

    // Gera e envia
    const resposta = await geminiGenerate(content);
    await sendText(from, resposta);
  } catch (error) {
    console.error("🔥 Erro:", error);
    await sendText(
      from,
      `Ops! Tive um probleminha técnico aqui 😅🍕\n\nPeça rapidinho pelo nosso cardápio online:\n${LINK_CARDAPIO}`
    );
  }
});

module.exports = router;
