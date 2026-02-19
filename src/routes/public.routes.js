const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");

const { loadRulesFromFiles } = require("../rules/loader");
const { getMode } = require("../services/context.service");
const { getUpsellHint } = require("../services/upsell.service");
const { quoteDeliveryIfPossible, MAX_KM } = require("../services/deliveryQuote.service");
const { createPixCharge } = require("../services/interPix.service");

const router = express.Router();
const prisma = new PrismaClient();

const LINK_CARDAPIO = "https://pappipizza.cardapioweb.com";

// ===============================
// Anti-duplicação
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
// Memória curta
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
// IA (Gemini via fetch)
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
  if (!picked) throw new Error("Nenhum modelo com generateContent disponível.");
  cachedGeminiModel = picked;
  console.log("🤖 Gemini model:", cachedGeminiModel);
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
// HELPERS WHATSAPP
// ===============================
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
    image: { link: imageUrl, caption: caption ? String(caption).slice(0, 900) : undefined },
  });
}

async function sendButtons(to, bodyText, buttons) {
  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: String(bodyText || "").slice(0, 900) },
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
  return sendButtons(to, "Pagamento vai ser como? 💳", [
    { id: "PAY_PIX", title: "⚡ PIX" },
    { id: "PAY_CARTAO", title: "💳 Cartão" },
    { id: "PAY_DINHEIRO", title: "💵 Dinheiro" },
  ]);
}

// ===============================
// Nome rápido + confirmação
// ===============================
const pendingName = new Map(); // phone -> nameGuess

function extractNameLight(text) {
  const t = String(text || "").trim();
  const m = t.match(
    /(?:meu nome é|aqui é o|aqui é a|sou o|sou a|me chamo)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2})/i
  );
  const name = m?.[1]?.trim();
  if (!name || name.length < 2) return null;
  return name.slice(0, 60);
}

function looksLikeJustAName(text) {
  const t = String(text || "").trim();
  if (t.length < 2 || t.length > 40) return false;
  if (/\d/.test(t)) return false;
  if (/[#@/\\:*+=<>]/.test(t)) return false;
  if (/\b(pizza|lasanha|entrega|retirada|pix|cart[aã]o|dinheiro|rua|av|avenida|bairro|cep)\b/i.test(t)) return false;
  if (!/^[A-Za-zÀ-ÿ\s]+$/.test(t)) return false;

  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 3) return false;

  const hasVowel = /[aeiouáàâãéêíóôõú]/i.test(t);
  if (!hasVowel) return false;

  return true;
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
// ADDRESS FLOW
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
// ÁUDIO
// ===============================
async function downloadAudio(mediaId) {
  try {
    if (!ENV.WHATSAPP_TOKEN) return null;

    const metaResp = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` },
    });

    const meta = await metaResp.json();
    if (!meta?.url) return null;

    const mediaResp = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` },
    });

    const mimeType = mediaResp.headers.get("content-type") || "audio/ogg";
    const buffer = await mediaResp.arrayBuffer();
    return { base64: Buffer.from(buffer).toString("base64"), mimeType };
  } catch (e) {
    console.error("❌ downloadAudio:", e?.message || e);
    return null;
  }
}

async function transcribeAndExtractFromAudio(base64, mimeType) {
  const PROMPT_AUDIO = `
Você é atendente da Pappi Pizza.
TRANSCRAVE o áudio e EXTRAIA campos, sem inventar.

Responda SOMENTE JSON válido:
{
  "transcription": "...",
  "customer_name": "..."|null,
  "delivery_or_pickup": "entrega"|"retirada"|null,
  "address_text": "..."|null,
  "payment": "pix"|"cartao"|"dinheiro"|null
}
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
    return { transcription: String(raw || "").trim(), customer_name: null, delivery_or_pickup: null, address_text: null, payment: null };
  }
}

// ===============================
// CARDAPIOWEB (curto)
// ===============================
async function getMerchant() {
  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
  try {
    const resp = await fetch(`${base}/api/partner/v1/merchant`, {
      headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, Accept: "application/json" },
    });
    return await resp.json();
  } catch (e) {
    console.error("❌ getMerchant:", e?.message || e);
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

  if (!Array.isArray(raw)) return "PIX, Cartão e Dinheiro";

  const names = raw
    .filter((p) => p && (p.ativo === true || p.active === true || p.enabled === true || p.status === "ACTIVE"))
    .map((p) => p?.método_de_pagamento || p?.metodo_de_pagamento || p?.name || p?.method || p?.type)
    .filter(Boolean);

  return names.length ? names.join(", ") : "PIX, Cartão e Dinheiro";
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
// WEBHOOK DO BANCO INTER
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

      if (customer) {
        await sendText(
          customer.phone,
          `✅ *Pagamento confirmado!* Recebemos seu PIX de R$ ${pag.valor}.\nSeu pedido já foi pra cozinha 🍕👨‍🍳`
        );
      }
    }
  } catch (error) {
    console.error("🔥 Erro webhook Inter:", error);
  }
});

// ===============================
// WEBHOOK WHATSAPP
// ===============================
router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;
  if (alreadyProcessed(msg.id)) return;

  const from = msg.from;

  try {
    // sempre carrega customer
    let customer = await prisma.customer.findUnique({ where: { phone: from } }).catch(() => null);
    if (!customer) customer = await prisma.customer.create({ data: { phone: from } });

    // ============================
    // BOTÕES (interactive)
    // ============================
    if (msg.type === "interactive") {
      const btnId = msg?.interactive?.button_reply?.id || null;

      // Nome
      if (btnId === "NAME_OK") {
        pendingName.delete(from);
        pushHistory(from, "user", "BOTÃO: nome confirmado");
        if (!customer.lastFulfillment) await askFulfillmentButtons(from);
        else if (!customer.preferredPayment) await askPaymentButtons(from);
        else await sendText(from, "Show ✅ Me diga seu pedido 🍕");
        return;
      }

      if (btnId === "NAME_EDIT") {
        pendingName.delete(from);
        await sendText(from, "Sem problema 🙂 Me diga seu nome, por favor.");
        return;
      }

      // Entrega/retirada
      if (btnId === "FULFILLMENT_ENTREGA" || btnId === "FULFILLMENT_RETIRADA") {
        const v = btnId === "FULFILLMENT_ENTREGA" ? "entrega" : "retirada";
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { lastFulfillment: v, lastInteraction: new Date() },
        });
        pushHistory(from, "user", `BOTÃO: ${v}`);

        // se entrega e não tem endereço, pede CEP/Localização curto
        if (v === "entrega" && !customer.lastAddress) {
          await sendText(from, "Pra entregar rapidinho: manda *CEP* ou *Localização 📍* 🙂");
          return;
        }

        if (!customer.preferredPayment) {
          await askPaymentButtons(from);
          return;
        }

        await sendText(from, "Show ✅ Me diga seu pedido 🍕");
        return;
      }

      // Pagamento
      if (btnId === "PAY_PIX" || btnId === "PAY_CARTAO" || btnId === "PAY_DINHEIRO") {
        const v = btnId === "PAY_PIX" ? "pix" : btnId === "PAY_CARTAO" ? "cartao" : "dinheiro";
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { preferredPayment: v, lastInteraction: new Date() },
        });
        pushHistory(from, "user", `BOTÃO: pagamento ${v}`);
        await sendText(from, "Perfeito ✅ Agora me diga seu pedido 🍕");
        return;
      }

      // Confirma endereço
      if (btnId === "ADDR_CONFIRM") {
        const af = getAF(from);
        const formatted = af?.pending?.formatted || null;

        if (formatted) {
          customer = await prisma.customer.update({
            where: { phone: from },
            data: { lastAddress: String(formatted).slice(0, 200), lastInteraction: new Date() },
          });
          pushHistory(from, "user", `ENDEREÇO CONFIRMADO: ${formatted}`);
        }

        resetAF(from);
        await sendText(from, "Endereço confirmado ✅ Agora me diga seu pedido 🍕");
        return;
      }

      if (btnId === "ADDR_CORRECT") {
        resetAF(from);
        await sendText(from, "Me manda *Rua + Número + Bairro* ou *CEP* ou *Localização 📍* 🙂");
        return;
      }

      return;
    }

    // ============================
    // Entrada: texto / áudio / localização
    // ============================
    let userText = "";
    let extracted = null;

    if (msg.type === "audio") {
      const audio = await downloadAudio(msg.audio?.id);
      if (!audio?.base64) {
        await sendText(from, "Não consegui ouvir 😕 Pode escrever pra mim?");
        return;
      }
      extracted = await transcribeAndExtractFromAudio(audio.base64, audio.mimeType);
      userText = String(extracted?.transcription || "").trim();
      if (userText) userText = `ÁUDIO: ${userText}`;
    }

    if (msg.type === "text") {
      userText = msg.text?.body || "";
      if (!userText) return;
    }

    if (msg.type === "location") {
      const lat = msg.location?.latitude;
      const lng = msg.location?.longitude;

      customer = await prisma.customer.update({
        where: { phone: from },
        data: { lastInteraction: new Date(), lastFulfillment: customer.lastFulfillment || "entrega" },
      });

      if (!lat || !lng) {
        await sendText(from, "Não consegui ler sua localização 😕 Pode mandar de novo?");
        return;
      }

      const formatted = await reverseGeocodeLatLng(lat, lng);
      if (!formatted) {
        await sendText(from, "Não consegui virar endereço 😕\nManda *Rua + Número + Bairro* ou *CEP*?");
        return;
      }

      const deliveryGPS = await quoteAny(formatted);
      if (!deliveryGPS?.ok) {
        await sendText(from, "Quase lá 😅 Confirma a localização ou manda *Rua + Número + Bairro* / *CEP*.");
        return;
      }

      const af = getAF(from);
      af.pending = { formatted, lat, lng };
      af.delivery = deliveryGPS;

      await askAddressConfirm(from, formatted, deliveryGPS);
      return;
    }

    // ============================
    // Atualiza dados do cliente (nome / envio / pagamento)
    // ============================
    if (userText) {
      const nm = extractNameLight(userText);
      const ff = detectFulfillmentLight(userText);
      const pay = detectPaymentLight(userText);

      const dataToUpdate = {};
      if (nm && !customer.name) dataToUpdate.name = nm;

      // nome puro (Alex Junior)
      if (!dataToUpdate.name && !customer.name && looksLikeJustAName(userText)) {
        const guess = userText.trim().slice(0, 40);
        pendingName.set(from, guess);

        // salva “tentativa” como nome (pra não ficar OPIPOJPO / lixo)
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { name: guess, lastInteraction: new Date() },
        });

        await sendButtons(from, `Seu nome é *${guess}*?`, [
          { id: "NAME_OK", title: "✅ Sim" },
          { id: "NAME_EDIT", title: "✏️ Corrigir" },
        ]);
        return;
      }

      if (ff) dataToUpdate.lastFulfillment = ff;
      if (pay) dataToUpdate.preferredPayment = pay;
      dataToUpdate.lastInteraction = new Date();

      if (Object.keys(dataToUpdate).length) {
        customer = await prisma.customer.update({ where: { phone: from }, data: dataToUpdate });
      }
    }

    // dados do áudio
    if (extracted) {
      const dataToUpdate = {};
      if (extracted.customer_name && !customer.name) dataToUpdate.name = String(extracted.customer_name).slice(0, 60);
      if (extracted.delivery_or_pickup) dataToUpdate.lastFulfillment = extracted.delivery_or_pickup;
      if (extracted.payment) dataToUpdate.preferredPayment = extracted.payment;
      if (Object.keys(dataToUpdate).length) {
        customer = await prisma.customer.update({ where: { phone: from }, data: dataToUpdate });
      }
    }

    if (userText) pushHistory(from, "user", userText);

    // ============================
    // Perguntas obrigatórias rápidas
    // ============================
    if (!customer.lastFulfillment) {
      await askFulfillmentButtons(from);
      return;
    }

    if (!customer.preferredPayment) {
      await askPaymentButtons(from);
      return;
    }

    // Se entrega e não tem endereço salvo: pede CEP/Localização (curto)
    if (customer.lastFulfillment === "entrega" && !customer.lastAddress) {
      // se texto parece endereço, tenta já
      const maybeCep = extractCep(userText);
      const maybeHasStreet = /rua|av|avenida|travessa|rodovia|estrada/i.test(userText);

      if (!maybeCep && !maybeHasStreet) {
        await sendText(from, "Pra entregar rapidinho: manda *CEP* ou *Localização 📍* 🙂");
        return;
      }
    }

    // ============================
    // Fluxo guiado do endereço (somente entrega)
    // ============================
    if (customer.lastFulfillment === "entrega" && msg.type === "text") {
      const af = getAF(from);
      const t = String(userText || "").trim();

      const cep = extractCep(t);
      if (cep) {
        af.cep = cep;
        af.step = "ASK_NUMBER";
        await sendText(from, "Perfeito ✅ Qual o *número* da casa?");
        return;
      }

      if (af.step === "ASK_NUMBER") {
        const n = extractHouseNumber(t);
        if (!n) {
          await sendText(from, "Me diz só o *número* 😊");
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
          await sendText(from, "Quase lá 😅 Manda *Rua + Número + Bairro* ou *Localização 📍*.");
          return;
        }

        af.pending = { formatted: d2.formatted };
        af.delivery = d2;
        await askAddressConfirm(from, d2.formatted, d2);
        return;
      }
    }

    // ============================
    // Tenta calcular entrega (Maps/taxa)
    // ============================
    let delivery = null;
    let deliveryInternal = `ENTREGA: não aplicável`;

    if (customer.lastFulfillment === "entrega") {
      const addressCandidate = extracted?.address_text || userText || customer.lastAddress || "";
      delivery = await quoteAny(addressCandidate);

      if (delivery?.ok && delivery.formatted) {
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { lastAddress: String(delivery.formatted).slice(0, 200) },
        });
        deliveryInternal = `ENTREGA: ${Number.isFinite(delivery?.km) ? delivery.km.toFixed(1) : "?"} km | Taxa: ${
          delivery?.fee != null ? `R$ ${Number(delivery.fee).toFixed(2)}` : "a confirmar"
        }`;
      }

      if (delivery?.ok && delivery.within === false) {
        await sendText(from, `Poxa 😕 ainda não entregamos aí (até ${MAX_KM} km). Quer mudar pra *Retirada*?`);
        return;
      }

      if (!delivery?.ok) {
        // inicia guiado se falhou e não estamos no fluxo
        const af = getAF(from);
        if (!af.step && !af.pending) {
          const maybeCep = extractCep(userText);
          if (maybeCep) {
            af.cep = maybeCep;
            af.step = "ASK_NUMBER";
            await sendText(from, "Qual o *número* da casa?");
            return;
          }
          // se parece rua sem número, pede número
          const num = extractHouseNumber(userText);
          if (!num && /rua|av|avenida|travessa|rodovia|estrada/i.test(userText)) {
            af.street = userText.trim().slice(0, 120);
            af.step = "ASK_NUMBER";
            await sendText(from, "Qual o *número*? (ou mande *CEP* / *Localização 📍*)");
            return;
          }
        }
      }
    }

    // ============================
    // Cérebro da IA (curto, sem menu gigante)
    // ============================
    const [merchant, configPix] = await Promise.all([
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

    const PROMPT = `
Você é o atendente virtual da Pappi Pizza (Campinas-SP).
Tom: simpático, direto, sem textão. Máximo 2 a 4 linhas.
NUNCA diga: "VIP", "modo", "evento", "interno", "Google", "Maps".

Já sabemos:
- Nome: ${customer.name || "?"}
- Envio: ${customer.lastFulfillment}
- Pagamento: ${customer.preferredPayment}
- Endereço (se entrega): ${customer.lastAddress || "não informado"}

Regras:
- Se cliente pedir sabores: sugira no máximo 5 e mande o link do cardápio.
- Se for entrega e faltar endereço: pedir CEP ou localização.
- Se pagamento for PIX e o pedido estiver pronto pra fechar, coloque no FINAL: [GERAR_PIX:valor] (ex: [GERAR_PIX:57.90])
- Sempre termine com 1 pergunta clara.

Regras da casa (interno):
${RULES}

Dados da loja:
- Endereço loja: ${enderecoLoja}
- Pagamentos: ${pagamentosLoja}
- PIX: ${pixKey}
- Cardápio: ${LINK_CARDAPIO}
${deliveryInternal}

Histórico:
${historyText}

Upsell (no máximo 1, se fizer sentido):
${upsell || "NENHUM"}
`.trim();

    const content = `${PROMPT}\n\nCliente: ${userText || "(sem texto)"}\nAtendente:`;
    let resposta = await geminiGenerate(content);

    // ============================
    // PIX INTERCEPT (gera QR + copia/cola)
    // ============================
    const pixMatch = resposta.match(/\[GERAR_PIX:(\d+\.\d{2})\]/);
    if (pixMatch) {
      const valorTotal = parseFloat(pixMatch[1]);
      resposta = resposta.replace(pixMatch[0], "").trim();

      // manda resposta “normal”
      if (resposta) {
        pushHistory(from, "assistant", resposta);
        await sendText(from, resposta);
      }

      const txid = `PAPPI${Date.now()}`;
      const pixData = await createPixCharge(txid, valorTotal, customer.name || "Cliente Pappi").catch(() => null);

      if (pixData && pixData.pixCopiaECola) {
        await prisma.order.create({
          data: {
            displayId: txid,
            status: "waiting_payment",
            total: valorTotal,
            items: "Pedido WhatsApp",
            customerId: customer.id,
          },
        });

        const qrCodeUrl = `https://quickchart.io/qr?size=300&text=${encodeURIComponent(pixData.pixCopiaECola)}`;
        await sendImage(from, qrCodeUrl, "📷 QR Code do PIX");
        await sendText(from, `PIX Copia e Cola:\n\n${pixData.pixCopiaECola}`);
      } else {
        await sendText(from, `Não consegui gerar o QR 😕\nPode usar a chave: *${pixKey}*`);
      }
      return;
    }

    pushHistory(from, "assistant", resposta);
    await sendText(from, resposta);
  } catch (error) {
    console.error("🔥 Erro:", error);
    await sendText(from, `Tive uma instabilidade 😅\nPeça aqui: ${LINK_CARDAPIO}`);
  }
});

module.exports = router;
