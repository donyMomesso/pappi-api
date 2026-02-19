const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");

const { loadRulesFromFiles } = require("../rules/loader");
const { getMode } = require("../services/context.service");
const { getUpsellHint } = require("../services/upsell.service");
const { quoteDeliveryIfPossible, MAX_KM } = require("../services/deliveryQuote.service");

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
// IA (Gemini) - auto resolve modelo via ListModels
// ===============================
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
let cachedGeminiModel = null;

async function listGeminiModels() {
  const apiKey = ENV.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada no Render.");

  const resp = await fetch(`${GEMINI_API_BASE}/models`, {
    headers: { "x-goog-api-key": apiKey },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`ListModels failed: ${resp.status} ${txt}`);
  }

  const data = await resp.json();
  return data.models || [];
}

function pickGeminiModel(models) {
  const supported = models.filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"));

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
  if (!picked) throw new Error("Nenhum modelo com generateContent disponível (ListModels não retornou suportados).");

  cachedGeminiModel = picked;
  console.log("🤖 Gemini model selecionado:", cachedGeminiModel);
  return cachedGeminiModel;
}

// ✅ aceita string OU array de parts (áudio)
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

  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
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
// ADDRESS FLOW (GUIADO + CEP + GPS) por telefone
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

// wrapper pra não quebrar caso sua deliveryQuote.service aceite (string) OU ({addressText})
async function quoteAny(addressText) {
  try {
    return await quoteDeliveryIfPossible(addressText);
  } catch {
    return await quoteDeliveryIfPossible({ addressText });
  }
}

// reverse geocode (GPS -> endereço)
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
  const etaTxt = delivery?.etaMin != null ? `${delivery.etaMin} min` : "";

  const txt =
    `Achei este endereço 📍:\n*${formatted}*\n` +
    `Taxa: *${feeTxt}*` +
    `${kmTxt ? ` | ${kmTxt}` : ""}` +
    `${etaTxt ? ` | ${etaTxt}` : ""}\n\n` +
    `Está certo?`;

  return sendButtons(to, txt, [
    { id: "ADDR_CONFIRM", title: "✅ Confirmar" },
    { id: "ADDR_CORRECT", title: "✏️ Corrigir" },
  ]);
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

async function transcribeAndExtractFromAudio(base64, mimeType) {
  const PROMPT_AUDIO = `
Você é atendente da Pappi Pizza.
Tarefa: TRANSCRAVA o áudio e EXTRAIA campos, sem inventar.

Responda SOMENTE JSON válido:
{
  "transcription": "...",
  "customer_name": "..."|null,
  "delivery_or_pickup": "entrega"|"retirada"|null,
  "address_text": "..."|null,
  "size_slices": 4|8|16|null,
  "is_half_half": true|false|null,
  "flavors": ["...","..."],
  "wants_menu": true|false|null,
  "payment": "pix"|"cartao"|"dinheiro"|null
}

Regras:
- Se falar "meio a meio", is_half_half=true.
- "16/gigante" => 16; "8/grande" => 8; "4/brotinho" => 4.
- Se pedir sabores/cardápio, wants_menu=true.
- Se disser entrega/retirada, capture.
- Se tiver rua+número+bairro no áudio, preencha address_text.
- Se disser nome (ex: "aqui é o Dony"), capture customer_name.
- Se falar pix/cartão/dinheiro, capture payment.
`.trim();

  const parts = [
    { text: PROMPT_AUDIO },
    { inlineData: { data: base64, mimeType: mimeType || "audio/ogg" } },
  ];

  const raw = await geminiGenerate(parts);

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
      customer_name: null,
      delivery_or_pickup: null,
      address_text: null,
      size_slices: null,
      is_half_half: null,
      flavors: [],
      wants_menu: null,
      payment: null,
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
// EXTRAÇÃO SIMPLES
// ===============================
function extractNameLight(text) {
  const t = String(text || "").trim();
  const m = t.match(/(?:meu nome é|aqui é o|aqui é a|sou o|sou a|me chamo)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2})/i);
  const name = m?.[1]?.trim();
  if (!name) return null;
  if (name.length < 2) return null;
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
  if (/cart[aã]o|credito|d[eé]bito/i.test(t)) return "cartao";
  if (/dinheiro|troco/i.test(t)) return "dinheiro";
  return null;
}

// ===============================
// Rotas básicas
// ===============================
router.get("/", (req, res) => res.send("Pappi API IA online 🧠✅"));
router.get("/health", (req, res) => res.json({ ok: true, app: "Pappi Pizza IA" }));

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

    // 2) Ler clique dos botões (interactive)
    if (msg.type === "interactive") {
      const btnId = msg?.interactive?.button_reply?.id || null;

      if (btnId === "FULFILLMENT_ENTREGA" || btnId === "FULFILLMENT_RETIRADA") {
        const v = btnId === "FULFILLMENT_ENTREGA" ? "entrega" : "retirada";
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { lastFulfillment: v, lastInteraction: new Date() },
        });
        pushHistory(from, "user", `BOTÃO: ${v}`);
      }

      if (btnId === "PAY_PIX" || btnId === "PAY_CARTAO" || btnId === "PAY_DINHEIRO") {
        const v = btnId === "PAY_PIX" ? "pix" : btnId === "PAY_CARTAO" ? "cartao" : "dinheiro";
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { preferredPayment: v, lastInteraction: new Date() },
        });
        pushHistory(from, "user", `BOTÃO: pagamento ${v}`);
      }

      // ✅ Botões do endereço
      if (btnId === "ADDR_CONFIRM") {
        const af = getAF(from);
        const formatted = af?.pending?.formatted || null;

        if (formatted) {
          await prisma.customer.update({
            where: { phone: from },
            data: { lastAddress: String(formatted).slice(0, 200), lastInteraction: new Date() },
          }).catch(() => null);

          pushHistory(from, "user", `ENDEREÇO CONFIRMADO: ${formatted}`);
        }

        resetAF(from);
        await sendText(from, "Perfeito ✅ Endereço confirmado! Agora me diga seu pedido 🍕");
        return;
      }

      if (btnId === "ADDR_CORRECT") {
        resetAF(from);
        await sendText(from, "Sem problema 😊 Me mande *Rua e Número* (ou seu *CEP* / sua *localização 📍*) pra eu calcular certinho.");
        return;
      }
    }

    // 3) Entrada (texto, áudio, localização)
    let userText = "";
    let extracted = null;

    if (msg.type === "audio") {
      const audio = await downloadAudio(msg.audio?.id);
      if (!audio?.base64) {
        await sendText(from, "Puxa, não consegui ouvir esse áudio 😕 Pode escrever pra mim?");
        return;
      }
      extracted = await transcribeAndExtractFromAudio(audio.base64, audio.mimeType);
      userText = `ÁUDIO TRANSCRITO: ${extracted.transcription || ""}`.trim();

    } else if (msg.type === "text") {
      userText = msg.text?.body || "";
      if (!userText) return;

    } else if (msg.type === "location") {
      const lat = msg.location?.latitude;
      const lng = msg.location?.longitude;

      await prisma.customer.update({
        where: { phone: from },
        data: { lastInteraction: new Date() },
      }).catch(() => null);

      // Se mandou localização, assume entrega (se ainda não escolheu)
      if (!customer.lastFulfillment) {
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { lastFulfillment: "entrega", lastInteraction: new Date() },
        }).catch(() => customer);
      }

      if (!lat || !lng) {
        await sendText(from, "Não consegui ler sua localização 😕 Pode mandar de novo?");
        return;
      }

      const formatted = await reverseGeocodeLatLng(lat, lng);
      if (!formatted) {
        await sendText(from, "Não consegui transformar sua localização em endereço 😕\nPode mandar *Rua + Número + Bairro* ou seu *CEP*?");
        return;
      }

      const deliveryGPS = await quoteAny(formatted);
      if (!deliveryGPS?.ok) {
        await sendText(from, "Quase lá 😅\nConfirma se sua localização está correta ou me manda *Rua + Número + Bairro* (ou *CEP*).");
        return;
      }

      const af = getAF(from);
      af.pending = { formatted, lat, lng };
      af.delivery = deliveryGPS;

      await askAddressConfirm(from, formatted, deliveryGPS);
      return;

    } else if (msg.type === "interactive") {
      userText = "";
    } else {
      return;
    }

    await prisma.customer.update({
      where: { phone: from },
      data: { lastInteraction: new Date() },
    }).catch(() => null);

    // Atualiza dados simples via texto
    if (userText) {
      const nm = extractNameLight(userText);
      const ff = detectFulfillmentLight(userText);
      const pay = detectPaymentLight(userText);

      const dataToUpdate = {};
      if (nm && !customer.name) dataToUpdate.name = nm;
      if (ff) dataToUpdate.lastFulfillment = ff;
      if (pay) dataToUpdate.preferredPayment = pay;

      if (Object.keys(dataToUpdate).length) {
        customer = await prisma.customer.update({
          where: { phone: from },
          data: dataToUpdate,
        }).catch(() => customer);
      }
    }

    // Atualiza dados extraídos do áudio
    if (extracted) {
      const dataToUpdate = {};

      if (extracted.customer_name && !customer.name) {
        const nm = String(extracted.customer_name).trim().slice(0, 60);
        if (nm.length >= 2) dataToUpdate.name = nm;
      }
      if (extracted.delivery_or_pickup) dataToUpdate.lastFulfillment = extracted.delivery_or_pickup;
      if (extracted.payment) dataToUpdate.preferredPayment = extracted.payment;

      if (Object.keys(dataToUpdate).length) {
        customer = await prisma.customer.update({
          where: { phone: from },
          data: dataToUpdate,
        }).catch(() => customer);
      }
    }

    if (userText) pushHistory(from, "user", userText);

    if (!customer.lastFulfillment) {
      await askFulfillmentButtons(from);
      return;
    }

    if (!customer.preferredPayment) {
      await askPaymentButtons(from);
      return;
    }

    // ===============================
    // Address Flow: respostas por etapa (somente entrega)
    // ===============================
    if (customer.lastFulfillment === "entrega" && msg.type === "text") {
      const af = getAF(from);
      const t = String(userText || "").trim();

      // CEP em qualquer momento
      const cep = extractCep(t);
      if (cep) {
        af.cep = cep;
        af.step = "ASK_NUMBER";
        await sendText(from, "Perfeito ✅ Agora me diga o *número* da casa (ex: 120).");
        return;
      }

      if (af.step === "ASK_NUMBER") {
        const n = extractHouseNumber(t);
        if (!n) {
          await sendText(from, "Me diz só o *número* da casa 😊 (ex: 120)");
          return;
        }
        af.number = n;
        af.step = "ASK_BAIRRO";
        await sendText(from, "Boa! Agora me diga o *bairro* 🙂");
        return;
      }

      if (af.step === "ASK_BAIRRO") {
        af.bairro = t.slice(0, 80);
        af.step = "ASK_COMPLEMENTO";
        await sendText(from, "Perfeito ✅ Tem *complemento*? (apto, bloco, referência). Se não tiver, diga *sem complemento*.");
        return;
      }

      if (af.step === "ASK_COMPLEMENTO") {
        af.complemento = looksLikeNoComplement(t) ? null : t.slice(0, 120);
        af.step = null;

        const full = buildAddressText(af);
        const d2 = await quoteAny(full);

        if (!d2?.ok) {
          await sendText(from, "Quase lá 😅 Pode mandar *Rua + Número + Bairro* completo ou sua *localização 📍*?");
          return;
        }

        af.pending = { formatted: d2.formatted };
        af.delivery = d2;

        await askAddressConfirm(from, d2.formatted, d2);
        return;
      }
    }

    const addressCandidate = extracted?.address_text || userText || "";
    let delivery = null;

    if (customer.lastFulfillment === "entrega") {
      delivery = await quoteAny(addressCandidate);

      if (delivery?.ok && delivery.formatted) {
        await prisma.customer.update({
          where: { phone: from },
          data: { lastAddress: String(delivery.formatted).slice(0, 200) },
        }).catch(() => null);
      }

      if (delivery?.ok && delivery.within === false) {
        await sendText(
          from,
          `Poxa 😕 por enquanto a gente ainda não entrega nessa região (até ${MAX_KM} km).\nMas você pode *retirar no balcão* rapidinho 😉\nQuer mudar pra *Retirada*?`
        );
        return;
      }

      // ✅ aqui entra o fluxo guiado (em vez de "não achei no mapa")
      if (!delivery?.ok) {
        const af = getAF(from);

        const cep = extractCep(addressCandidate);
        if (cep) {
          af.cep = cep;
          af.step = "ASK_NUMBER";
          await sendText(from, "Perfeito ✅ Agora me diga o *número* da casa (ex: 120).");
          return;
        }

        const num = extractHouseNumber(addressCandidate);

        // veio só rua (sem número)
        if (!num) {
          af.street = String(addressCandidate || "").trim().slice(0, 120);
          af.step = "ASK_NUMBER";
          await sendText(from, "Perfeito 🙌 Agora me diga o *número* da casa.\nSe preferir, mande seu *CEP* ou sua *localização 📍*.");
          return;
        }

        // tem número, pedir bairro
        if (!af.street) af.street = String(addressCandidate || "").trim().slice(0, 120);
        af.number = num;

        if (!af.bairro) {
          af.step = "ASK_BAIRRO";
          await sendText(from, "Show! Qual é o *bairro*? 😊");
          return;
        }

        // já tem bairro → pedir complemento
        af.step = "ASK_COMPLEMENTO";
        await sendText(from, "Tem *complemento*? (apto, bloco, referência). Se não tiver, diga *sem complemento*.");
        return;
      }
    }

    const [menu, merchant, configPix] = await Promise.all([
      getMenu(),
      getMerchant(),
      prisma.config.findUnique({ where: { key: "CHAVE_PIX" } }).catch(() => null),
    ]);

    const enderecoLoja = normalizeAddress(merchant);
    const pagamentosLoja = normalizePayments(merchant);
    const pix = configPix?.value || "PIX: 19 9 8319 3999 - Darclee Duran";

    const mode = getMode({ customer, now: new Date() });
    const RULES = loadRulesFromFiles(mode);
    const historyText = getHistoryText(from);
    const upsell = getUpsellHint({ historyText, userText });

    const deliveryInternal =
      customer.lastFulfillment === "entrega" && delivery?.ok
        ? `ENTREGA (interno): ${delivery.km?.toFixed?.(1) ?? "?"} km | ETA ${delivery.eta_minutes ?? delivery.etaMin ?? "?"} min | taxa aprox ${delivery.delivery_fee ?? delivery.fee ?? "consultar"}`
        : `ENTREGA (interno): não aplicável`;

    const PROMPT = `
Você é o atendente virtual da Pappi Pizza (Campinas-SP).
Tom: caloroso, simpático e objetivo. Emojis moderadamente.

REGRAS CRÍTICAS:
- NUNCA diga ao cliente: "VIP", "modo", "evento", "Google", "Maps", "interno".
- Não repita perguntas já feitas. Use o HISTÓRICO.
- Primeira impressão: se não souber o nome, pergunte 1x (depois pare).
- Já sabemos:
  - Nome: ${customer.name || "desconhecido"}
  - Entrega/Retirada: ${customer.lastFulfillment}
  - Pagamento: ${customer.preferredPayment}
- Se for entrega:
  - Se faltar endereço, pedir Rua + Número + Bairro ou CEP ou Localização.
  - Se estiver fora do raio, oferecer retirada.
- Se cliente pedir sabores, resuma e sugira 2 campeãs do dia.
- Sempre finalize com 1 pergunta clara.

REGRAS POR MODO (interno):
${RULES}

DADOS DA LOJA:
- Endereço: ${enderecoLoja}
- Pagamentos (da loja): ${pagamentosLoja}
- PIX: ${pix}
- Cardápio online: ${LINK_CARDAPIO}

${deliveryInternal}

CARDÁPIO:
${menu}

HISTÓRICO:
${historyText}

UPSELL (usar no máximo 1 se fizer sentido):
${upsell || "NENHUM"}
`.trim();

    const content = `${PROMPT}\n\nCliente: ${userText || "(clique em botão)"}\nAtendente:`;
    const resposta = await geminiGenerate(content);

    pushHistory(from, "assistant", resposta);
    await sendText(from, resposta);
  } catch (error) {
    console.error("🔥 Erro:", error);
    await sendText(
      from,
      `Tive uma instabilidade rapidinha 😅🍕\nMe manda: seu pedido + se é entrega ou retirada.\nSe preferir, peça aqui:\n${LINK_CARDAPIO}`
    );
  }
});

module.exports = router;
} catch (error) {
    console.error("🔥 Erro:", error);
    await sendText(
      from,
      `Tive uma instabilidade rapidinha 😅🍕\nMe manda: seu pedido + se é entrega ou retirada.\nSe preferir, peça aqui:\n${LINK_CARDAPIO}`
    );
  }
});

module.exports = router;
