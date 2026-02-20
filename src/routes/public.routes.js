// src/routes/public.routes.js
const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");

const { loadRulesFromFiles } = require("../rules/loader");
const { getMode } = require("../services/context.service");
const { getUpsellHint } = require("../services/upsell.service");
const { quoteDeliveryIfPossible, MAX_KM } = require("../services/deliveryQuote.service");
const { createPixCharge } = require("../services/interPix.service");

// Node 18+ tem fetch global. Se der erro no seu ambiente, descomente:
// const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

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
  return h
    .map((x) => (x.role === "user" ? `Cliente: ${x.text}` : `Atendente: ${x.text}`))
    .join("\n");
}

// ===============================
// DISC (detecção leve + tom humano)
// ===============================
function detectDISC(historyText, userText) {
  const t = `${historyText}\n${userText}`.toLowerCase();
  const score = { D: 0, I: 0, S: 0, C: 0 };

  // D
  if (/(rápido|agora|urgente|pra ontem|resolve|quero logo|sem enrolar|objetivo|direto)/i.test(t)) score.D += 3;
  if (/(quanto fica|valor|taxa|preço|total|fechou|manda)/i.test(t)) score.D += 2;

  // I
  if (/(kkk|haha|top|show|amei|perfeito|manda aí|bora|😍|😂|🔥|👏)/i.test(t)) score.I += 3;
  if (/(promo|novidade|qual recomenda|surpreende|capricha)/i.test(t)) score.I += 2;

  // S
  if (/(tranquilo|de boa|sem pressa|tanto faz|pode ser|confio|obrigado|valeu)/i.test(t)) score.S += 3;
  if (/(família|criança|pra todo mundo|clássica)/i.test(t)) score.S += 1;

  // C
  if (/(detalhe|certinho|confirma|comprovante|conforme|tamanho|ingrediente|sem|com|meio a meio|observação)/i.test(t)) score.C += 3;
  if (/(cep|número|bairro|endereço|nota|troco|cartão|pix)/i.test(t)) score.C += 2;

  let best = "S";
  let bestVal = -1;
  for (const k of ["D", "I", "S", "C"]) {
    if (score[k] > bestVal) {
      bestVal = score[k];
      best = k;
    }
  }
  return best;
}

function discToneGuidance(disc) {
  switch (disc) {
    case "D":
      return `Tom: direto e rápido. Frases curtas. 1 pergunta por vez. Máx 1 emoji.`;
    case "I":
      return `Tom: animado e caloroso. Pode usar 1–2 emojis. Sugira 1 recomendação.`;
    case "C":
      return `Tom: claro e organizado. Confirme detalhes (tamanho, sabores, endereço). Sem textão.`;
    case "S":
    default:
      return `Tom: acolhedor e tranquilo. Passe segurança. 1 pergunta por vez.`;
  }
}

// ===============================
// IA (Gemini) - auto resolve modelo via ListModels
// ===============================
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
let cachedGeminiModel = null;

async function listGeminiModels() {
  const apiKey = ENV.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada.");

  const resp = await fetch(`${GEMINI_API_BASE}/models`, {
    headers: { "x-goog-api-key": apiKey },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`ListModels failed: ${resp.status} ${txt}`);
  }
  const data = await resp.json().catch(() => ({}));
  return data.models || [];
}

function pickGeminiModel(models) {
  const supported = models.filter((m) =>
    (m.supportedGenerationMethods || []).includes("generateContent")
  );

  const preferred = [
    (ENV.GEMINI_MODEL || "").replace(/^models\//, ""),
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
  ].filter(Boolean);

  for (const name of preferred) {
    const full = name.startsWith("models/") ? name : `models/${name}`;
    const found = supported.find((m) => m.name === full);
    if (found) return found.name;
  }
  return supported[0]?.name || null;
}

async function ensureGeminiModel() {
  if (cachedGeminiModel) return cachedGeminiModel;
  const models = await listGeminiModels();
  const picked = pickGeminiModel(models);
  if (!picked) throw new Error("Nenhum modelo com generateContent disponível.");
  cachedGeminiModel = picked;
  console.log("🤖 Gemini model selecionado:", cachedGeminiModel);
  return cachedGeminiModel;
}

async function geminiGenerate(content) {
  const apiKey = ENV.GEMINI_API_KEY || "";
  const model = await ensureGeminiModel();

  const body = Array.isArray(content)
    ? { contents: [{ parts: content }] }
    : { contents: [{ parts: [{ text: String(content || "") }] }] };

  const resp = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`generateContent failed: ${resp.status} ${JSON.stringify(data)}`);

  return (
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || ""
  );
}

// ===============================
// HELPERS (WhatsApp)
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
    headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
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

async function sendImage(to, imageUrl, caption) {
  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "image",
    image: { link: imageUrl, caption: caption ? String(caption).slice(0, 1000) : undefined },
  });
}

async function sendButtons(to, bodyText, buttons) {
  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: String(b.id), title: String(b.title).slice(0, 20) },
        })),
      },
    },
  });
}

async function askFulfillmentButtons(to) {
  return sendButtons(to, "Pra agilizar 😊 é *Entrega* ou *Retirada*?", [
    { id: "FULFILLMENT_ENTREGA", title: "🚚 Entrega" },
    { id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" },
  ]);
}

async function askPaymentButtons(to) {
  return sendButtons(to, "E o pagamento vai ser como? 💳", [
    { id: "PAY_PIX", title: "⚡ PIX" },
    { id: "PAY_CARTAO", title: "💳 Cartão" },
    { id: "PAY_DINHEIRO", title: "💵 Dinheiro" },
  ]);
}

// ===============================
// PEDIDO (rascunho) por telefone
// ===============================
const orderDraft = new Map(); // phone -> { text, updatedAt }
function getDraft(phone) {
  return orderDraft.get(phone) || null;
}
function setDraft(phone, text) {
  orderDraft.set(phone, { text: String(text || "").slice(0, 600), updatedAt: Date.now() });
}
function clearDraft(phone) {
  orderDraft.delete(phone);
}
function looksLikeOrderIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  if (/(quero|me vê|manda|pedir|fechar|vou querer|faz aí|fazer um pedido)/i.test(t)) return true;

  if (/(pizza|calabresa|mussarela|muçarela|frango|portuguesa|4 queijos|quatro queijos|meia|metade|borda|grande|m[eé]dia|pequena)/i.test(t))
    return true;

  if (/(quanto fica|valor|preço|preco|taxa)/i.test(t) && t.length < 25) return false;

  return false;
}

// ===============================
// ADDRESS FLOW (GUIADO + CEP + GPS)
// ===============================
const addressFlow = new Map(); // phone -> { step, street, number, bairro, cep, complemento, pending, delivery }
function getAF(phone) {
  if (!addressFlow.has(phone)) addressFlow.set(phone, { step: null });
  return addressFlow.get(phone);
}
function resetAF(phone) {
  addressFlow.set(phone, { step: null });
}

function extractCep(text) {
  const d = digitsOnly(text);
  return d.length === 8 ? d : null;
}
function extractHouseNumber(text) {
  const m = String(text || "").match(/\b\d{1,5}\b/);
  return m ? m[0] : null;
}
function looksLikeNoComplement(text) {
  return /^(sem|não tem|nao tem)\s*(complemento)?$/i.test(String(text || "").trim());
}
function buildAddressText(af) {
  const parts = [];
  if (af.street) parts.push(af.street);
  if (af.number) parts.push(af.number);
  if (af.bairro) parts.push(af.bairro);
  if (af.cep) parts.push(`CEP ${af.cep}`);
  if (af.complemento) parts.push(af.complemento);
  return `${parts.join(" - ")}, Campinas - SP`;
}
async function quoteAny(addressText) {
  try {
    return await quoteDeliveryIfPossible(addressText);
  } catch {
    return await quoteDeliveryIfPossible({ addressText });
  }
}
async function reverseGeocodeLatLng(lat, lng) {
  if (!ENV.GOOGLE_MAPS_API_KEY) return null;

  const url =
    `https://maps.googleapis.com/maps/api/geocode/json?` +
    `latlng=${lat},${lng}` +
    `&key=${ENV.GOOGLE_MAPS_API_KEY}` +
    `&language=pt-BR` +
    `&result_type=street_address|premise|subpremise|route`;

  const resp = await fetch(url).catch(() => null);
  if (!resp) return null;

  const data = await resp.json().catch(() => null);
  return data?.results?.[0]?.formatted_address || null;
}
async function askAddressConfirm(to, formatted, delivery) {
  const feeTxt = delivery?.fee != null ? `R$ ${Number(delivery.fee).toFixed(2)}` : "a confirmar";
  const kmTxt = Number.isFinite(delivery?.km) ? `${delivery.km.toFixed(1)} km` : "";
  const txt = `Confere o endereço? 📍\n*${formatted}*\nTaxa: *${feeTxt}*${kmTxt ? ` | ${kmTxt}` : ""}`;

  return sendButtons(to, txt, [
    { id: "ADDR_CONFIRM", title: "✅ Confirmar" },
    { id: "ADDR_CORRECT", title: "✏️ Corrigir" },
  ]);
}

function looksLikeAddress(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  if (extractCep(t)) return true;

  const hasStreetWord = /(rua|r\.|avenida|av\.|travessa|tv\.|alameda|rodovia|estrada|praça|praca|bairro|nº|n\.)/i.test(t);
  const hasNumber = /\b\d{1,5}\b/.test(t);

  const isIntentPhrase = /(pizza|quanto|preço|preco|rápido|rapido|valor|card[aá]pio|menu|promo)/i.test(t);
  if (isIntentPhrase && !hasStreetWord) return false;

  return (hasStreetWord && hasNumber) || (hasStreetWord && t.length >= 10);
}

// ===============================
// EXTRAÇÃO SIMPLES (nome, envio, pagamento)
// ===============================
function extractNameLight(text) {
  const t = String(text || "").trim();

  if (/^[A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2}$/.test(t) && t.length >= 2) {
    if (/^(sim|nao|não|ok|blz|beleza|oi|ola|olá)$/i.test(t)) return null;
    return t.slice(0, 60);
  }

  const m = t.match(
    /(?:meu nome é|aqui é o|aqui é a|sou o|sou a|me chamo)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2})/i
  );
  const name = m?.[1]?.trim();
  if (!name || name.length < 2) return null;
  return name.slice(0, 60);
}
function detectFulfillmentLight(text) {
  const t = String(text || "").toLowerCase();
  if (/retirada|retirar|balc[aã]o|vou buscar/i.test(t)) return "retirada";
  if (/entrega|delivery|entregar/i.test(t)) return "entrega";
  return null;
}
function detectPaymentLight(text) {
  const t = String(text || "").toLowerCase();
  if (/pix/i.test(t)) return "pix";
  if (/cart[aã]o|credito|crédito|d[eé]bito/i.test(t)) return "cartao";
  if (/dinheiro|troco/i.test(t)) return "dinheiro";
  return null;
}

// pergunta nome só 1x por sessão (processo)
const askedName = new Set();
function shouldAskName(phone, customer) {
  if (customer?.name) return false;
  if (askedName.has(phone)) return false;
  askedName.add(phone);
  return true;
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

    const data = await resp.json().catch(() => ({}));
    if (!data?.categories) return "Cardápio indisponível.";

    let txt = "🍕 MENU PAPPI:\n";
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
    return "Cardápio indisponível.";
  }
}

async function getMerchant() {
  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
  const url = `${base}/api/partner/v1/merchant`;

  try {
    const resp = await fetch(url, {
      headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, Accept: "application/json" },
    });
    return await resp.json().catch(() => null);
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

  if (!Array.isArray(raw)) return "PIX, Cartão, Dinheiro";

  const names = raw
    .filter((p) => p && (p.ativo === true || p.active === true || p.enabled === true || p.status === "ACTIVE"))
    .map((p) => p?.método_de_pagamento || p?.metodo_de_pagamento || p?.name || p?.method || p?.type)
    .filter(Boolean);

  return names.length ? names.join(", ") : "PIX, Cartão, Dinheiro";
}

function normalizeAddress(merchant) {
  const addr = merchant?.endereço || merchant?.endereco || merchant?.address || null;
  if (!addr) return "Campinas-SP";

  const rua = addr?.rua || addr?.street || "";
  const numero = addr?.número || addr?.numero || addr?.number || "";
  const bairro = addr?.bairro || addr?.district || "";

  const parts = [rua, numero, bairro].filter(Boolean).join(", ");
  return parts || "Campinas-SP";
}

// ===============================
// Rotas básicas
// ===============================
router.get("/", (req, res) => res.send("Pappi API IA online 🧠✅"));
router.get("/health", (req, res) => res.json({ ok: true, app: "Pappi Pizza IA" }));

// ===============================
// WEBHOOK DO BANCO INTER (PIX)
// ===============================
router.post("/webhook/inter", async (req, res) => {
  res.sendStatus(200);

  const pagamentos = req.body;
  if (!pagamentos || !Array.isArray(pagamentos)) return;

  try {
    for (const pag of pagamentos) {
      console.log(`💰 PIX RECEBIDO! TXID: ${pag.txid} | Valor: R$ ${pag.valor}`);

      const order = await prisma.order.findFirst({ where: { displayId: pag.txid } });
      if (!order) continue;

      await prisma.order.update({ where: { id: order.id }, data: { status: "confirmed" } });

      const customer = await prisma.customer.findUnique({ where: { id: order.customerId } });
      if (customer?.phone) {
        await sendText(
          customer.phone,
          `✅ Pagamento confirmado! Recebemos R$ ${pag.valor}.\nPedido enviado pra cozinha 🍕👨‍🍳`
        );
      }
    }
  } catch (error) {
    console.error("🔥 Erro webhook Inter:", error);
  }
});

// ===============================
// WEBHOOK PRINCIPAL (WhatsApp Cloud)
// ===============================
router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;
  if (alreadyProcessed(msg.id)) return;

  const from = msg.from;

  try {
    let customer = await prisma.customer.findUnique({ where: { phone: from } }).catch(() => null);
    if (!customer) customer = await prisma.customer.create({ data: { phone: from } });

    // --------------------------
    // Entrada (texto / localização / botão)
    // --------------------------
    let userText = "";
    let clickedButtonId = null;

    // Botões
    if (msg.type === "interactive") {
      clickedButtonId = msg?.interactive?.button_reply?.id || null;

      if (clickedButtonId === "FULFILLMENT_ENTREGA" || clickedButtonId === "FULFILLMENT_RETIRADA") {
        const v = clickedButtonId === "FULFILLMENT_ENTREGA" ? "entrega" : "retirada";
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { lastFulfillment: v, lastInteraction: new Date() },
        });
        pushHistory(from, "user", `BOTÃO: ${v}`);
        userText = "(clicou no botão)";
      }

      if (clickedButtonId === "PAY_PIX" || clickedButtonId === "PAY_CARTAO" || clickedButtonId === "PAY_DINHEIRO") {
        const v = clickedButtonId === "PAY_PIX" ? "pix" : clickedButtonId === "PAY_CARTAO" ? "cartao" : "dinheiro";
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { preferredPayment: v, lastInteraction: new Date() },
        });
        pushHistory(from, "user", `BOTÃO: pagamento ${v}`);
        userText = "(clicou no botão)";
      }

      if (clickedButtonId === "ADDR_CONFIRM") {
        const af = getAF(from);
        const formatted = af?.pending?.formatted || null;

        if (formatted) {
          await prisma.customer
            .update({
              where: { phone: from },
              data: { lastAddress: String(formatted).slice(0, 200), lastInteraction: new Date() },
            })
            .catch(() => null);

          pushHistory(from, "user", `ENDEREÇO CONFIRMADO: ${formatted}`);
        }

        resetAF(from);
        await sendText(from, "Fechado ✅ Agora me diga seu pedido 🍕 (tamanho + sabores)");
        return;
      }

      if (clickedButtonId === "ADDR_CORRECT") {
        resetAF(from);
        await sendText(from, "Me manda *CEP* ou *Rua + Número + Bairro* (ou sua localização 📍).");
        return;
      }

      // se foi um botão desconhecido, só segue com userText padrão
      if (!userText) userText = "(clicou no botão)";
    }

    // Localização
    if (msg.type === "location") {
      const lat = msg.location?.latitude;
      const lng = msg.location?.longitude;

      if (!lat || !lng) {
        await sendText(from, "Não consegui ler sua localização 😕 Manda de novo?");
        return;
      }

      if (!customer.lastFulfillment) {
        customer = await prisma.customer
          .update({
            where: { phone: from },
            data: { lastFulfillment: "entrega", lastInteraction: new Date() },
          })
          .catch(() => customer);
      }

      const formatted = await reverseGeocodeLatLng(lat, lng);
      if (!formatted) {
        await sendText(from, "Não achei no mapa 😕 Manda *Rua + Número + Bairro* ou *CEP*.");
        return;
      }

      const deliveryGPS = await quoteAny(formatted);
      if (!deliveryGPS?.ok) {
        await sendText(from, "Quase! Confirma o endereço ou manda *Rua + Número + Bairro* / *CEP*.");
        return;
      }

      const af = getAF(from);
      af.pending = { formatted, lat, lng };
      af.delivery = deliveryGPS;

      await askAddressConfirm(from, formatted, deliveryGPS);
      return;
    }

    // Texto
    if (msg.type === "text") {
      userText = msg.text?.body || "";
      if (!userText) return;
    }

    // se não é text/location/interactive, sai
    if (!["text", "location", "interactive"].includes(msg.type)) return;

    // --------------------------
    // Atualiza customer (nome / entrega / pagamento) quando vier texto de verdade
    // --------------------------
    if (msg.type === "text") {
      const nm = extractNameLight(userText);
      const ff = detectFulfillmentLight(userText);
      const pay = detectPaymentLight(userText);

      const dataToUpdate = { lastInteraction: new Date() };
      if (nm && !customer.name) dataToUpdate.name = nm;
      if (ff) dataToUpdate.lastFulfillment = ff;
      if (pay) dataToUpdate.preferredPayment = pay;

      customer = await prisma.customer
        .update({ where: { phone: from }, data: dataToUpdate })
        .catch(() => customer);
    } else {
      // botão também atualiza interação
      customer = await prisma.customer
        .update({ where: { phone: from }, data: { lastInteraction: new Date() } })
        .catch(() => customer);
    }

    // registra histórico da mensagem recebida
    pushHistory(from, "user", userText);

    // --------------------------
    // Pergunta nome 1x para quem só manda "oi/sim"
    // --------------------------
    if (
      shouldAskName(from, customer) &&
      msg.type === "text" &&
      /^(oi|olá|ola|sim|boa|boa noite|bom dia|boa tarde)$/i.test(userText.trim())
    ) {
      await sendText(from, "Pra eu te atender certinho 😊 qual seu nome?");
      return;
    }

    // --------------------------
    // Se não escolheu entrega/retirada, pergunta
    // --------------------------
    if (!customer.lastFulfillment) {
      await askFulfillmentButtons(from);
      return;
    }

    // --------------------------
    // Captura “pedido” antes de travar em endereço/pagamento
    // --------------------------
    if (msg.type === "text" && !looksLikeAddress(userText)) {
      if (looksLikeOrderIntent(userText)) setDraft(from, userText);
    }

    // Se não tem rascunho ainda, pede pedido (sem loop)
    const draft = getDraft(from);

    if (!draft && customer.lastFulfillment === "retirada") {
      await sendText(from, "Fechado 🙌 Qual pizza você quer? (tamanho + sabores, ou meia a meia)");
      return;
    }

    if (!draft && customer.lastFulfillment === "entrega" && !customer.lastAddress) {
      await sendText(from, "Top! Qual pizza você quer? (tamanho + sabores). Depois eu pego o endereço pra calcular a taxa 😊");
      return;
    }

    // --------------------------
    // Endereço (só se entrega) — guiado + cotação
    // --------------------------
    let delivery = null;

    if (customer.lastFulfillment === "entrega") {
      const af = getAF(from);

      // Se já tem endereço salvo e o texto atual NÃO parece endereço, não tenta recotar
      const textLooksAddr = msg.type === "text" ? looksLikeAddress(userText) : false;

      if (customer.lastAddress && !textLooksAddr && af.step == null) {
        // segue sem mexer no endereço
      } else {
        // 1) tenta cotar com o que tiver (endereço salvo ou texto)
        const candidate = customer.lastAddress || (msg.type === "text" ? userText : "");
        if (candidate && String(candidate).trim() !== "") {
          delivery = await quoteAny(candidate);
        }

        // 2) se ok e não tinha lastAddress, salva
        if (delivery?.ok && delivery.formatted && !customer.lastAddress) {
          await prisma.customer
            .update({
              where: { phone: from },
              data: { lastAddress: String(delivery.formatted).slice(0, 200) },
            })
            .catch(() => null);
          customer.lastAddress = String(delivery.formatted).slice(0, 200);
        }

        // 3) fora do raio
        if (delivery?.ok && delivery.within === false) {
          await sendText(from, `Ainda não entregamos aí (até ${MAX_KM} km). Quer *Retirada*?`);
          return;
        }

        // 4) se não conseguiu cotar e o texto parece endereço (ou já está no fluxo), entra no guiado
        if (!delivery?.ok && (af.step != null || (msg.type === "text" && looksLikeAddress(userText)))) {
          const t = String(userText || "").trim();

          // CEP -> pede número
          const cep = extractCep(t);
          if (cep) {
            af.cep = cep;
            af.step = "ASK_NUMBER";
            await sendText(from, "Perfeito ✅ Qual o *número* da casa?");
            return;
          }

          // fluxo guiado
          if (af.step === "ASK_NUMBER") {
            const n = extractHouseNumber(t);
            if (!n) {
              await sendText(from, "Me diz só o *número* da casa 😊");
              return;
            }
            af.number = n;
            af.step = "ASK_BAIRRO";
            await sendText(from, "Boa! Qual o *bairro*?");
            return;
          }

          if (af.step === "ASK_BAIRRO") {
            af.bairro = t.slice(0, 80);
            af.step = "ASK_COMPLEMENTO";
            await sendText(from, "Tem *complemento*? Se não tiver, diga *sem*.");
            return;
          }

          if (af.step === "ASK_COMPLEMENTO") {
            af.complemento = looksLikeNoComplement(t) ? null : t.slice(0, 120);
            af.step = null;

            const full = buildAddressText(af);
            const d2 = await quoteAny(full);
            if (!d2?.ok) {
              await sendText(from, "Quase lá 😅 Manda *Rua + Número + Bairro* certinho?");
              return;
            }

            af.pending = { formatted: d2.formatted };
            await askAddressConfirm(from, d2.formatted, d2);
            return;
          }

          // começa guiado: assume que mandou rua sem número
          const num = extractHouseNumber(t);
          if (!num) {
            af.street = t.slice(0, 120);
            af.step = "ASK_NUMBER";
            await sendText(from, "Perfeito 🙌 Agora me diga o *número*.\nSe preferir, mande seu *CEP* ou *localização 📍*.");
            return;
          }

          // rua + número (pede bairro)
          af.street = t.slice(0, 120);
          af.number = num;
          af.step = "ASK_BAIRRO";
          await sendText(from, "Show! Qual é o *bairro*? 😊");
          return;
        }

        // 5) se ainda não tem endereço (e não parece endereço), pede endereço de forma objetiva
        if (!customer.lastAddress && af.step == null && msg.type === "text") {
          // Só pede endereço quando o cliente já deu pedido (draft existe) — pra não travar no começo
          if (draft) {
            await sendText(from, "Agora me manda *CEP* ou *Rua + Número + Bairro* (ou sua localização 📍) pra eu calcular a taxa 😊");
            return;
          }
        }
      }
    }

    // --------------------------
    // Pagamento (só depois de: retirada OK / entrega com endereço OK)
    // --------------------------
    if (!customer.preferredPayment) {
      // se entrega, só pergunta pagamento quando já tiver endereço confirmado/salvo
      if (customer.lastFulfillment === "entrega" && !customer.lastAddress) {
        // não pergunta pagamento ainda
      } else {
        await askPaymentButtons(from);
        return;
      }
    }

    // --------------------------
    // Cérebro (IA)
    // --------------------------
    const [menu, merchant, configPix] = await Promise.all([
      getMenu(),
      getMerchant(),
      prisma.config.findUnique({ where: { key: "CHAVE_PIX" } }).catch(() => null),
    ]);

    const enderecoLoja = normalizeAddress(merchant);
    const pagamentosLoja = normalizePayments(merchant);
    const pixKey = configPix?.value || "19 9 8319 3999";

    const mode = getMode({ customer, now: new Date() });
    const RULES = loadRulesFromFiles(mode);
    const historyText = getHistoryText(from);
    const upsell = getUpsellHint({ historyText, userText });

    const disc = detectDISC(historyText, userText);
    const tone = discToneGuidance(disc);

    const deliveryInternal =
      customer.lastFulfillment === "entrega" && (delivery?.ok || customer.lastAddress)
        ? `ENTREGA (interno): ${delivery?.km?.toFixed?.(1) ?? "?"} km | taxa ${delivery?.fee ?? "?"}`
        : `ENTREGA (interno): não aplicável`;

    const draftText = getDraft(from)?.text || "";

    const PROMPT = `
Você atende como humano da Pappi Pizza (Campinas-SP). Não diga que é robô/IA.
Fale natural, sem frases repetidas.
${tone}

REGRAS CRÍTICAS:
- NUNCA diga: "VIP", "modo", "evento", "interno", "Google", "Maps".
- Já sabemos:
  - Nome: ${customer.name || "desconhecido"}
  - Entrega/Retirada: ${customer.lastFulfillment}
  - Pagamento: ${customer.preferredPayment || "desconhecido"}

ROTEIRO OBRIGATÓRIO (1 pergunta por vez):
1) Se não souber o nome, pergunte.
2) Confirme tamanho e sabores (pergunte se é meio a meio).
3) Ofereça borda e bebida + observação (sem cebola/interfone).
4) Se pagamento for dinheiro: pergunte do troco (somente nesse caso).
5) Faça resumo final (tamanho, sabores, borda, bebida, observações, taxa se entrega) e peça OK.

PIX:
- Quando o cliente CONFIRMAR finalizar e pagamento for PIX,
  adicione no FINAL: [GERAR_PIX:valor] (ex: [GERAR_PIX:57.90]).

SE ENTREGA:
- Se faltar endereço, pedir: CEP ou Rua+Número+Bairro ou Localização.
- Se fora do raio, oferecer retirada.

Sempre termine com 1 pergunta curta.

REGRAS (interno):
${RULES}

DADOS:
- Endereço loja: ${enderecoLoja}
- Pagamentos: ${pagamentosLoja}
- PIX: ${pixKey}
- Cardápio: ${LINK_CARDAPIO}
${deliveryInternal}

RASCUNHO DO PEDIDO (se existir):
${draftText || "NENHUM"}

CARDÁPIO:
${menu}

HISTÓRICO:
${historyText}

UPSELL (no máximo 1):
${upsell || "NENHUM"}
`.trim();

    const content = `${PROMPT}\n\nCliente: ${userText}\nAtendente:`;
    let resposta = await geminiGenerate(content);

    // --------------------------
    // PIX INTERCEPT
    // --------------------------
    const pixMatch = resposta.match(/\[GERAR_PIX:(\d+\.\d{2})\]/);
    if (pixMatch) {
      const valorTotal = parseFloat(pixMatch[1]);
      resposta = resposta.replace(pixMatch[0], "").trim();

      if (resposta) await sendText(from, resposta);

      const txid = `PAPPI${Date.now()}`;
      const pixData = await createPixCharge(txid, valorTotal, customer.name || "Cliente Pappi");

      if (pixData?.pixCopiaECola) {
        await prisma.order.create({
          data: {
            displayId: txid,
            status: "waiting_payment",
            total: valorTotal,
            items: draftText ? `Pedido via WhatsApp: ${draftText}` : "Pedido via WhatsApp",
            customerId: customer.id,
          },
        });

        const qrCodeUrl = `https://quickchart.io/qr?size=300&text=${encodeURIComponent(
          pixData.pixCopiaECola
        )}`;
        await sendImage(from, qrCodeUrl, "QR Code PIX ✅");
        await sendText(from, `Copia e Cola:\n${pixData.pixCopiaECola}`);

        // pedido já “fechado”, limpa rascunho
        clearDraft(from);
      } else {
        await sendText(from, `Não consegui gerar o QR agora 😅\nChave PIX: ${pixKey}`);
      }

      pushHistory(from, "assistant", resposta || "[PIX GERADO]");
      return;
    }

    // resposta normal
    pushHistory(from, "assistant", resposta);
    await sendText(from, resposta);
  } catch (error) {
    console.error("🔥 Erro:", error);
    await sendText(from, `Deu uma instabilidade 😅\nPede aqui: ${LINK_CARDAPIO}`);
  }
});

module.exports = router;
