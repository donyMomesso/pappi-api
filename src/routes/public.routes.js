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

// =====================================================
// Anti-duplicação (WhatsApp pode reenviar)
// =====================================================
const processedMsgIds = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processedMsgIds.has(id)) return true;
  processedMsgIds.add(id);
  if (processedMsgIds.size > 5000) processedMsgIds.clear();
  return false;
}

// =====================================================
// Memória curta por telefone (últimas 12 falas)
// =====================================================
const chatHistory = new Map();
function pushHistory(phone, role, text) {
  if (!chatHistory.has(phone)) chatHistory.set(phone, []);
  const h = chatHistory.get(phone);
  h.push({ role, text: String(text || "").slice(0, 900) });
  if (h.length > 12) h.splice(0, h.length - 12);
}
function getHistoryText(phone) {
  const h = chatHistory.get(phone) || [];
  return h
    .map((x) => (x.role === "user" ? `Cliente: ${x.text}` : `Atendente: ${x.text}`))
    .join("\n");
}
function detectLoop(phone) {
  const h = chatHistory.get(phone) || [];
  const last2 = h.slice(-2).filter((x) => x.role === "assistant").map((x) => x.text);
  if (last2.length < 2) return false;
  return last2[0] === last2[1];
}

// =====================================================
// HANDOFF (modo humano) - NÃO depende de migrate
// (tenta gravar no Prisma se existir campos; se não existir, usa memória)
// =====================================================
const handoffMemory = new Map(); // phone -> { on: true, at: ts }

function isHandoffOn(phone, customer) {
  if (customer && customer.handoff === true) return true; // se seu schema tiver
  const mem = handoffMemory.get(phone);
  return mem?.on === true;
}

async function setHandoffOn(phone) {
  handoffMemory.set(phone, { on: true, at: Date.now() });
  // tenta persistir, se seu schema tiver os campos
  await prisma.customer
    .update({
      where: { phone },
      data: { handoff: true, handoffAt: new Date(), lastInteraction: new Date() },
    })
    .catch(() => null);
}

async function clearHandoff(phone) {
  handoffMemory.delete(phone);
  await prisma.customer
    .update({
      where: { phone },
      data: { handoff: false, lastInteraction: new Date() },
    })
    .catch(() => null);
}

// =====================================================
// Desescalation (irritação / pedir atendente)
// =====================================================
function detectHumanRequest(text) {
  const t = String(text || "").toLowerCase();
  return /(humano|atendente|pessoa|moça|moca|falar com|me atende|quero atendimento|chama alguém|gerente)/i.test(
    t
  );
}
function detectIrritation(text) {
  const t = String(text || "").toLowerCase();
  return /(caracas|aff|pqp|irritad|raiva|rid[ií]culo|absurdo|lixo|merda|porra|n[aã]o aguento|ta errado|de novo|para|chega|vsf)/i.test(
    t
  );
}

async function askDeescalationButtons(to) {
  return sendButtons(to, "Entendi 🙏 Vamos resolver agora. Como prefere?", [
    { id: "HELP_HUMAN", title: "👩‍💼 Atendente" },
    { id: "HELP_BOT", title: "✅ Continuar" },
    { id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" },
  ]);
}

// =====================================================
// IA (Gemini) - auto resolve modelo via ListModels
// =====================================================
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

// =====================================================
// HELPERS (WHATSAPP)
// =====================================================
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

// =====================================================
// ADDRESS FLOW (GUIADO + CEP + GPS)
// =====================================================
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

function looksLikeAddress(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  // CEP
  if (extractCep(t)) return true;

  const hasStreetWord = /(rua|r\.|avenida|av\.|travessa|tv\.|alameda|rodovia|estrada|praça|praca|bairro|nº|n\.)/i.test(
    t
  );
  const hasNumber = /\b\d{1,5}\b/.test(t);

  // evita frases de intenção
  const isIntentPhrase = /(pizza|quanto|preço|preco|rápido|rapido|valor|card[aá]pio|menu|promo|atendente|moça|moca)/i.test(
    t
  );

  if (isIntentPhrase && !hasStreetWord) return false;

  return (hasStreetWord && hasNumber) || (hasStreetWord && t.length >= 10) || (hasNumber && t.length >= 12);
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
    `&language=pt-BR`;

  const resp = await fetch(url).catch(() => null);
  const data = await resp?.json().catch(() => null);
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

// =====================================================
// EXTRAÇÃO SIMPLES (nome, envio, pagamento)
// =====================================================
function extractNameLight(text) {
  const t = String(text || "").trim();

  // pega nomes simples tipo "Dony" ou "Dony Momesso"
  if (/^[A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2}$/.test(t) && t.length >= 2) {
    if (/^(sim|nao|não|ok|blz|beleza|oi|ola|olá|menu)$/i.test(t)) return null;
    return t.slice(0, 60);
  }

  const m = t.match(
    /(?:meu nome é|aqui é o|aqui é a|sou o|sou a|me chamo)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2})/i
  );
  const name = m?.[1]?.trim();
  if (!name || name.length < 2) return null;
  return name.slice(0, 60);
}

function looksLikeGarbageName(name) {
  const n = String(name || "").trim();
  if (n.length < 2) return true;
  const vowels = (n.match(/[aeiouáàâãéèêíìîóòôõúùû]/gi) || []).length;
  if (vowels < 2) return true;
  if (/(.)\1\1/.test(n)) return true;
  return false;
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

// Pergunta nome só 1x por sessão
const askedName = new Set();
function shouldAskName(phone, customer) {
  if (customer?.name) return false;
  if (askedName.has(phone)) return false;
  askedName.add(phone);
  return true;
}

// =====================================================
// CARDAPIOWEB
// =====================================================
async function getMenu() {
  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
  const url = `${base}/api/partner/v1/catalog`;
  try {
    const resp = await fetch(url, {
      headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, Accept: "application/json" },
    });
    const data = await resp.json();
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

// =====================================================
// Rotas básicas
// =====================================================
router.get("/", (req, res) => res.send("Pappi API IA online 🧠✅"));
router.get("/health", (req, res) => res.json({ ok: true, app: "Pappi Pizza IA" }));

// =====================================================
// WEBHOOK DO BANCO INTER (PIX)
// =====================================================
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
        await sendText(customer.phone, `✅ Pagamento confirmado! Recebemos R$ ${pag.valor}.\nPedido enviado pra cozinha 🍕👨‍🍳`);
      }
    }
  } catch (error) {
    console.error("🔥 Erro webhook Inter:", error);
  }
});

// =====================================================
// WEBHOOK PRINCIPAL (WhatsApp Cloud)
// =====================================================
router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;
  if (alreadyProcessed(msg.id)) return;

  const from = msg.from;

  try {
    let customer = await prisma.customer.findUnique({ where: { phone: from } }).catch(() => null);
    if (!customer) customer = await prisma.customer.create({ data: { phone: from } });

    // Se está em handoff, o bot NÃO responde
    if (isHandoffOn(from, customer)) return;

    // --------------------------
    // 1) Botões (interactive)
    // --------------------------
    if (msg.type === "interactive") {
      const btnId = msg?.interactive?.button_reply?.id || null;

      if (btnId === "HELP_HUMAN") {
        pushHistory(from, "user", "BOTÃO: atendente");
        await setHandoffOn(from);
        await sendText(from, "Perfeito ✅ Já chamei um atendente pra continuar aqui com você. Só um instantinho 😊");
        return;
      }

      if (btnId === "HELP_BOT") {
        pushHistory(from, "user", "BOTÃO: continuar");
        await sendText(from, "Fechado ✅ Vou te atender por aqui. É *Entrega* ou *Retirada*?");
        await askFulfillmentButtons(from);
        return;
      }

      if (btnId === "FULFILLMENT_ENTREGA" || btnId === "FULFILLMENT_RETIRADA") {
        const v = btnId === "FULFILLMENT_ENTREGA" ? "entrega" : "retirada";
        customer = await prisma.customer
          .update({ where: { phone: from }, data: { lastFulfillment: v, lastInteraction: new Date() } })
          .catch(() => customer);
        pushHistory(from, "user", `BOTÃO: ${v}`);
      }

      if (btnId === "PAY_PIX" || btnId === "PAY_CARTAO" || btnId === "PAY_DINHEIRO") {
        const v = btnId === "PAY_PIX" ? "pix" : btnId === "PAY_CARTAO" ? "cartao" : "dinheiro";
        customer = await prisma.customer
          .update({ where: { phone: from }, data: { preferredPayment: v, lastInteraction: new Date() } })
          .catch(() => customer);
        pushHistory(from, "user", `BOTÃO: pagamento ${v}`);
      }

      if (btnId === "ADDR_CONFIRM") {
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
        await sendText(from, "Fechado ✅ Agora me diga seu pedido 🍕 (tamanho + sabor / meia a meia)");
        return;
      }

      if (btnId === "ADDR_CORRECT") {
        resetAF(from);
        await sendText(from, "Me manda *CEP* ou *Rua + Número + Bairro* (ou sua localização 📍).");
        return;
      }

      // se foi outro botão, segue o fluxo normal pedindo texto depois
      await sendText(from, "Beleza 😊 Me diga seu pedido (tamanho + sabores).");
      return;
    }

    // --------------------------
    // 2) Entrada (texto ou localização)
    // --------------------------
    let userText = "";

    if (msg.type === "text") {
      userText = msg.text?.body || "";
      if (!userText) return;

      // intervenção: humano/irritação/loop
      if (detectHumanRequest(userText) || detectIrritation(userText) || detectLoop(from)) {
        pushHistory(from, "user", userText);
        await sendText(from, "Entendi 🙏 desculpa a confusão. Vamos resolver agora.");
        await askDeescalationButtons(from);
        return;
      }
    } else if (msg.type === "location") {
      const lat = msg.location?.latitude;
      const lng = msg.location?.longitude;

      if (!lat || !lng) {
        await sendText(from, "Não consegui ler sua localização 😕 Manda de novo?");
        return;
      }

      // se não tem fulfillment, assume entrega e pergunta depois
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
        await sendText(from, "Quase! Me manda *CEP* ou *Rua + Número + Bairro* que eu calculo certinho 😊");
        return;
      }

      const af = getAF(from);
      af.pending = { formatted, lat, lng };
      af.delivery = deliveryGPS;

      await askAddressConfirm(from, formatted, deliveryGPS);
      return;
    } else {
      return;
    }

    // --------------------------
    // 3) Atualiza customer (nome / entrega / pagamento) sem aceitar “nome lixo”
    // --------------------------
    const nm = extractNameLight(userText);
    const ff = detectFulfillmentLight(userText);
    const pay = detectPaymentLight(userText);

    const dataToUpdate = { lastInteraction: new Date() };
    if (nm && !customer.name && !looksLikeGarbageName(nm)) dataToUpdate.name = nm;
    if (ff) dataToUpdate.lastFulfillment = ff;
    if (pay) dataToUpdate.preferredPayment = pay;

    customer = await prisma.customer.update({ where: { phone: from }, data: dataToUpdate }).catch(() => customer);
    pushHistory(from, "user", userText);

    // --------------------------
    // 4) Nome (se não souber) — pergunta ANTES de enrolar o fluxo
    // --------------------------
    if (shouldAskName(from, customer) && /^(oi|olá|ola|sim|boa|boa noite|bom dia|boa tarde|menu)$/i.test(userText.trim())) {
      await sendText(from, "Pra eu te atender certinho 😊 me diz seu *nome*? (ex: Dony)");
      return;
    }

    // se cliente digitou um “nome lixo”, força pedir nome
    if (!customer.name && nm && looksLikeGarbageName(nm)) {
      await sendText(from, "Me diz seu *nome* por favor? 😊 (ex: Dony)");
      return;
    }

    // --------------------------
    // 5) Entrega/Retirada (sempre pergunta se não tiver)
    // --------------------------
    if (!customer.lastFulfillment) {
      await askFulfillmentButtons(from);
      return;
    }

    // --------------------------
    // 6) Endereço só se ENTREGA e só se parecer endereço
    //    (NUNCA pode travar ou “falhar mapa” -> se Google falhar, cai pra fluxo guiado)
    // --------------------------
    let delivery = null;
    let deliveryInternal = `ENTREGA (interno): não aplicável`;

    if (customer.lastFulfillment === "entrega") {
      const af = getAF(from);
      const t = String(userText || "").trim();

      // Se já tem lastAddress e o cliente não está mandando outra coisa, tenta cotar com lastAddress
      const candidateToQuote =
        customer.lastAddress && !looksLikeAddress(t) ? customer.lastAddress : (looksLikeAddress(t) ? t : null);

      if (candidateToQuote) {
        delivery = await quoteAny(candidateToQuote);
      }

      // Se cotou OK, guarda e segue
      if (delivery?.ok) {
        if (delivery.formatted && !customer.lastAddress) {
          await prisma.customer
            .update({ where: { phone: from }, data: { lastAddress: String(delivery.formatted).slice(0, 200) } })
            .catch(() => null);
        }

        if (delivery.within === false) {
          await sendText(from, `Ainda não entregamos aí (até ${MAX_KM} km). Quer *Retirada*?`);
          return;
        }

        const kmTxt = Number.isFinite(delivery?.km) ? delivery.km.toFixed(1) : "?";
        const feeTxt = delivery?.fee != null ? Number(delivery.fee).toFixed(2) : "a confirmar";
        deliveryInternal = `ENTREGA (interno): ${kmTxt} km | Taxa: R$ ${feeTxt}`;
      } else {
        // Google falhou OU endereço incompleto -> fluxo guiado SEM crash
        // Só entra se o texto parece endereço OU se já está no passo do fluxo
        if (looksLikeAddress(t) || af.step) {
          // CEP -> pergunta número
          const cep = extractCep(t);
          if (cep) {
            af.cep = cep;
            af.step = "ASK_NUMBER";
            await sendText(from, "Perfeito ✅ Qual o *número* da casa?");
            return;
          }

          // Se já está no fluxo guiado
          if (af.step === "ASK_NUMBER") {
            const n = extractHouseNumber(t);
            if (!n) { await sendText(from, "Me diz só o *número* da casa 😊"); return; }
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

            // Se mesmo assim Google falhar, NÃO trava: confirma manual e segue
            if (!d2?.ok) {
              af.pending = { formatted: full };
              await askAddressConfirm(from, full, { fee: null, km: null });
              return;
            }

            af.pending = { formatted: d2.formatted };
            await askAddressConfirm(from, d2.formatted, d2);
            return;
          }

          // Começa fluxo guiado: pede número/bairro
          const num = extractHouseNumber(t);
          if (!num) {
            af.street = t.slice(0, 120);
            af.step = "ASK_NUMBER";
            await sendText(from, "Perfeito 🙌 Agora me diga o *número*.\nSe preferir, mande seu *CEP* ou *localização 📍*.");
            return;
          }

          af.street = t.slice(0, 120);
          af.number = num;
          af.step = "ASK_BAIRRO";
          await sendText(from, "Show! Qual é o *bairro*? 😊");
          return;
        }

        // Se está em entrega mas ainda sem endereço salvo, pede endereço (sem insistir demais)
        if (!customer.lastAddress) {
          await sendText(from, "Pra entrega, me manda *CEP* ou *Rua + Número + Bairro* (ou sua localização 📍) pra eu calcular a taxa 😊");
          return;
        }
      }
    }

    // --------------------------
    // 7) Pagamento (só pede depois que: entrega tem endereço confirmado ou é retirada)
    // --------------------------
    if (!customer.preferredPayment) {
      await askPaymentButtons(from);
      return;
    }

    // --------------------------
    // 8) Se não tem nome ainda, pergunta aqui (ANTES da IA)
    // --------------------------
    if (!customer.name) {
      await sendText(from, "Antes de fechar 😊 qual seu *nome*?");
      return;
    }
// ==========================================
// BUSCA DIRETA DE SABOR NO CARDÁPIO
// ==========================================
if (msg.type === "text" && userText) {
  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
  const url = `${base}/api/partner/v1/catalog`;

  try {
    const resp = await fetch(url, {
      headers: {
        "X-API-KEY": ENV.CARDAPIOWEB_TOKEN,
        Accept: "application/json",
      },
    });

    const data = await resp.json().catch(() => null);

    if (resp.ok && data?.categories) {
      const search = userText.toLowerCase();
      let foundItem = null;

      for (const cat of data.categories) {
        if (cat?.status !== "ACTIVE") continue;

        for (const item of cat.items || []) {
          if (item?.status !== "ACTIVE") continue;

          if (item.name.toLowerCase().includes(search)) {
            foundItem = item;
            break;
          }
        }
        if (foundItem) break;
      }

      if (foundItem) {
        await sendText(
          from,
          `Temos sim 😊\n\n🍕 *${foundItem.name}*\nValor: R$ ${Number(foundItem.price).toFixed(2)}\n\nVocê quer ela de 8 ou 16 fatias?`
        );
        return;
      }
    }
  } catch (e) {
    console.log("Busca específica falhou:", e.message);
  }
}
    // --------------------------
    // 9) Cérebro (IA) — com roteiro e sem quebrar fluxo
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

    const PROMPT = `
Você atende como humano da Pappi Pizza (Campinas-SP). Não diga que é robô/IA.
Fale natural, sem frases repetidas. Uma pergunta por vez.

REGRAS CRÍTICAS:
- Se o cliente pedir atendente/humano, responda educado e ofereça: "Posso chamar um atendente ou resolver por aqui. O que prefere?"
- Se o cliente demonstrar irritação, peça desculpas e simplifique: faça 1 pergunta curta por vez.
- NUNCA diga: "VIP", "modo", "evento", "interno", "Google", "Maps".

JÁ SABEMOS:
- Nome: ${customer.name}
- Entrega/Retirada: ${customer.lastFulfillment}
- Pagamento: ${customer.preferredPayment}
- Link cardápio: ${LINK_CARDAPIO}

ROTEIRO (obrigatório):
1) Confirmar o pedido: tamanho + sabores (e se é meia a meia).
2) Oferecer: borda recheada + bebida (1 sugestão no máximo).
3) Se ENTREGA e ainda falta endereço, pedir CEP ou Rua+Número+Bairro ou Localização.
4) Se pagamento for DINHEIRO, perguntar troco.
5) Resumir tudo e quando o cliente CONFIRMAR finalização e for PIX, colocar no final: [GERAR_PIX:valor] (ex: [GERAR_PIX:57.90])

DADOS:
- Endereço loja: ${enderecoLoja}
- Pagamentos: ${pagamentosLoja}
- PIX: ${pixKey}
${deliveryInternal}

REGRAS (interno):
${RULES}

CARDÁPIO:
${menu}

HISTÓRICO:
${historyText}

UPSELL (no máximo 1):
${upsell || "NENHUM"}
`.trim();

    const content = `${PROMPT}\n\nCliente: ${userText}\nAtendente:`;
    let resposta = "";

    try {
      resposta = await geminiGenerate(content);
    } catch (e) {
      console.error("❌ Gemini falhou:", e?.message || e);
      await sendText(from, "Tive uma instabilidade 😅 Mas consigo te atender: me diz *tamanho* e *sabor* da pizza, por favor.");
      return;
    }

    // --------------------------
    // 10) PIX INTERCEPT
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
            items: "Pedido via WhatsApp",
            customerId: customer.id,
          },
        });

        const qrCodeUrl = `https://quickchart.io/qr?size=300&text=${encodeURIComponent(pixData.pixCopiaECola)}`;
        await sendImage(from, qrCodeUrl, "QR Code PIX ✅");
        await sendText(from, `Copia e Cola:\n${pixData.pixCopiaECola}`);
      } else {
        await sendText(from, `Não consegui gerar o QR agora 😅\nChave PIX: ${pixKey}`);
      }

      pushHistory(from, "assistant", resposta || "[PIX GERADO]");
      return;
    }

    pushHistory(from, "assistant", resposta);
    await sendText(from, resposta);
  } catch (error) {
    console.error("🔥 Erro:", error);
    // nunca “mata” o cliente: cai pro cardápio + pergunta simples
    await sendText(from, `Deu uma instabilidade 😅\nMe diz *tamanho* e *sabor* da pizza? (ou peça aqui: ${LINK_CARDAPIO})`);
  }
});

module.exports = router;
