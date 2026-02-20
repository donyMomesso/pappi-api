// src/routes/public.routes.js
const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");

const fetch = global.fetch || require("node-fetch");

const { loadRulesFromFiles } = require("../rules/loader");
const { getMode } = require("../services/context.service");
const { getUpsellHint } = require("../services/upsell.service");
const { quoteDeliveryIfPossible, MAX_KM } = require("../services/deliveryQuote.service");
const { createPixCharge } = require("../services/interPix.service");

// Cardápio Web (CORRETO: dupla autenticação)
const { createOrder, getPaymentMethods } = require("../services/cardapioWeb.service");

const router = express.Router();
const prisma = new PrismaClient();

const LINK_CARDAPIO = "https://pappipizza.cardapioweb.com";

// ===================================================
// Anti-duplicação (WhatsApp pode reenviar)
// ===================================================
const processedMsgIds = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processedMsgIds.has(id)) return true;
  processedMsgIds.add(id);
  if (processedMsgIds.size > 5000) processedMsgIds.clear();
  return false;
}

// ===================================================
// Memória curta por telefone (últimas 12 falas)
// ===================================================
const chatHistory = new Map();
function pushHistory(phone, role, text) {
  if (!chatHistory.has(phone)) chatHistory.set(phone, []);
  const h = chatHistory.get(phone);
  h.push({ role, text: String(text || "").slice(0, 900) });
  if (h.length > 12) h.splice(0, h.length - 12);
}
function getHistoryText(phone) {
  const h = chatHistory.get(phone) || [];
  return h.map((x) => (x.role === "user" ? `Cliente: ${x.text}` : `Atendente: ${x.text}`)).join("\n");
}
function detectLoop(phone) {
  const h = chatHistory.get(phone) || [];
  const last2 = h.slice(-2).filter((x) => x.role === "assistant").map((x) => x.text);
  if (last2.length < 2) return false;
  return last2[0] === last2[1];
}

// ===================================================
// DISC (detecção leve + tom humano)
// ===================================================
function detectDISC(historyText, userText) {
  const t = `${historyText}\n${userText}`.toLowerCase();
  const score = { D: 0, I: 0, S: 0, C: 0 };

  if (/(rápido|agora|urgente|pra ontem|resolve|quero logo|sem enrolar|objetivo|direto)/i.test(t)) score.D += 3;
  if (/(quanto fica|valor|taxa|preço|total|fechou|manda)/i.test(t)) score.D += 2;

  if (/(kkk|haha|top|show|amei|perfeito|manda aí|bora|😍|😂|🔥|👏)/i.test(t)) score.I += 3;
  if (/(promo|novidade|qual recomenda|surpreende|capricha)/i.test(t)) score.I += 2;

  if (/(tranquilo|de boa|sem pressa|tanto faz|pode ser|confio|obrigado|valeu)/i.test(t)) score.S += 3;
  if (/(família|criança|pra todo mundo|clássica)/i.test(t)) score.S += 1;

  if (/(detalhe|certinho|confirma|comprovante|conforme|tamanho|ingrediente|sem|com|meio a meio|observação)/i.test(t)) score.C += 3;
  if (/(cep|número|bairro|endereço|nota|troco|cartão|pix)/i.test(t)) score.C += 2;

  let best = "S";
  let bestVal = -1;
  for (const k of ["D", "I", "S", "C"]) {
    if (score[k] > bestVal) { bestVal = score[k]; best = k; }
  }
  return best;
}

function discToneGuidance(disc) {
  switch (disc) {
    case "D": return `Tom: direto e rápido. Frases curtas. 1 pergunta por vez. Máx 1 emoji.`;
    case "I": return `Tom: animado e caloroso. Pode usar 1–2 emojis. Sugira 1 recomendação.`;
    case "C": return `Tom: claro e organizado. Confirme detalhes (tamanho, sabores, endereço). Sem textão.`;
    case "S": default: return `Tom: acolhedor e tranquilo. Passe segurança. 1 pergunta por vez.`;
  }
}

// ===================================================
// HANDOFF (modo humano)
// ===================================================
const handoffMemory = new Map();

function isHandoffOn(phone, customer) {
  if (customer && customer.handoff === true) return true;
  const mem = handoffMemory.get(phone);
  return mem?.on === true;
}

async function setHandoffOn(phone) {
  handoffMemory.set(phone, { on: true, at: Date.now() });
  await prisma.customer.update({
    where: { phone }, data: { handoff: true, handoffAt: new Date(), lastInteraction: new Date() },
  }).catch(() => null);
}

async function clearHandoff(phone) {
  handoffMemory.delete(phone);
  await prisma.customer.update({
    where: { phone }, data: { handoff: false, lastInteraction: new Date() },
  }).catch(() => null);
}

// ===================================================
// Desescalation (irritação / pedir atendente)
// ===================================================
function detectHumanRequest(text) {
  const t = String(text || "").toLowerCase();
  return /(humano|atendente|pessoa|moça|moca|falar com|me atende|quero atendimento|chama alguém|gerente)/i.test(t);
}
function detectIrritation(text) {
  const t = String(text || "").toLowerCase();
  return /(caracas|aff|pqp|irritad|raiva|rid[ií]culo|absurdo|lixo|merda|porra|n[aã]o aguento|ta errado|de novo|para|chega|vsf)/i.test(t);
}

async function askDeescalationButtons(to) {
  return sendButtons(to, "Entendi 🙏 Vamos resolver agora. Como prefere?", [
    { id: "HELP_HUMAN", title: "👩‍💼 Atendente" },
    { id: "HELP_BOT", title: "✅ Continuar" },
    { id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" },
  ]);
}

// ===================================================
// Draft do pedido
// ===================================================
const askedName = new Set();
const orderDraft = new Map();

function getDraft(phone) { return orderDraft.get(phone) || null; }
function setDraft(phone, text) { orderDraft.set(phone, { text: String(text || "").slice(0, 700), updatedAt: Date.now() }); }
function clearDraft(phone) { orderDraft.delete(phone); }

function looksLikeOrderIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (/(quero|pedir|fecha|fechar|vou querer|manda|me vê)/i.test(t)) return true;
  if (/(pizza|calabresa|mussarela|frango|portuguesa|4 queijos|quatro queijos|meia|metade|borda|grande|m[eé]dia|pequena|gigante|16|12|8)/i.test(t)) return true;
  if (/(quanto|valor|preço|preco|taxa)/i.test(t) && t.length < 30) return false;
  return false;
}

// ===================================================
// Helpers texto / endereço
// ===================================================
function digitsOnly(str) { return String(str || "").replace(/\D/g, ""); }
function extractCep(text) { const d = digitsOnly(text); return d.length === 8 ? d : null; }
function extractHouseNumber(text) { const m = String(text || "").match(/\b\d{1,5}\b/); return m ? m[0] : null; }
function looksLikeNoComplement(text) { return /^(sem|não tem|nao tem)\s*(complemento)?$/i.test(String(text || "").trim()); }

function looksLikeAddress(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (extractCep(t)) return true;
  const hasStreetWord = /(rua|r\.|avenida|av\.|travessa|tv\.|alameda|rodovia|estrada|praça|praca|bairro|n[ºo]\b|n\.)/i.test(t);
  const hasNumber = /\b\d{1,5}\b/.test(t);
  const isIntentPhrase = /(pizza|quanto|preço|preco|valor|card[aá]pio|menu|promo|rápido|rapido)/i.test(t);
  if (isIntentPhrase && !hasStreetWord) return false;
  return (hasStreetWord && hasNumber) || (hasStreetWord && t.length >= 10);
}

// ===================================================
// EXTRAÇÃO LEVE (nome / entrega / pagamento)
// ===================================================
function extractNameLight(text) {
  const t = String(text || "").trim();
  if (/^[A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2}$/.test(t) && t.length >= 2) {
    if (/^(sim|nao|não|ok|blz|beleza|oi|ola|olá)$/i.test(t)) return null;
    return t.slice(0, 60);
  }
  const m = t.match(/(?:meu nome é|aqui é o|aqui é a|sou o|sou a|me chamo)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2})/i);
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

function shouldAskName(phone, customer) {
  if (customer?.name) return false;
  if (askedName.has(phone)) return false;
  askedName.add(phone);
  return true;
}

// ===================================================
// WhatsApp Cloud API helpers
// ===================================================
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
    text: { body: String(text || "").slice(0, 3500) }
  });
}

async function sendImage(to, imageUrl, caption) {
  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "image",
    image: { link: imageUrl, caption: caption ? String(caption).slice(0, 1000) : undefined }
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
          reply: { id: String(b.id), title: String(b.title).slice(0, 20) }
        }))
      }
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

// ===================================================
// Address Flow (GUIADO + CEP + GPS)
// ===================================================
const addressFlow = new Map();

function getAF(phone) {
  if (!addressFlow.has(phone)) addressFlow.set(phone, { step: null });
  return addressFlow.get(phone);
}
function resetAF(phone) { addressFlow.set(phone, { step: null }); }

function buildAddressText(af) {
  const parts = [];
  if (af.street) parts.push(af.street);
  if (af.number) parts.push(af.number);
  if (af.bairro) parts.push(af.bairro);
  if (af.cep) parts.push(`CEP ${af.cep}`);
  if (af.complemento) parts.push(af.complemento);
  return `${parts.join(" - ")}, Campinas - SP`;
}

async function safeQuote(addressText) {
  try { return await quoteDeliveryIfPossible(addressText); }
  catch (e1) {
    try { return await quoteDeliveryIfPossible({ addressText }); }
    catch (e2) { return null; }
  }
}

async function reverseGeocodeLatLng(lat, lng) {
  if (!ENV.GOOGLE_MAPS_API_KEY) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${ENV.GOOGLE_MAPS_API_KEY}&language=pt-BR&result_type=street_address|premise|subpremise|route`;
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

// ===================================================
// IA (Gemini) - RÁPIDA E EFICIENTE
// ===================================================
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
let cachedGeminiModel = null;
let geminiDisabledUntil = 0;

function isGeminiDisabled() { return Date.now() < geminiDisabledUntil; }
function disableGeminiFor(ms) { geminiDisabledUntil = Date.now() + ms; }

async function listGeminiModels() {
  const apiKey = ENV.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada.");
  const resp = await fetch(`${GEMINI_API_BASE}/models`, { headers: { "x-goog-api-key": apiKey } });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.models || [];
}

function pickGeminiModel(models) {
  const supported = models.filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"));
  const preferred = [(ENV.GEMINI_MODEL || "").replace(/^models\//, ""), "gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"].filter(Boolean);
  for (const name of preferred) {
    const full = name.startsWith("models/") ? name : `models/${name}`;
    const found = supported.find((m) => m.name === full);
    if (found) return found.name;
  }
  return supported[0]?.name || null;
}

async function ensureGeminiModel(forceRefresh = false) {
  if (cachedGeminiModel && !forceRefresh) return cachedGeminiModel;
  const models = await listGeminiModels();
  const picked = pickGeminiModel(models);
  if (!picked) throw new Error("Nenhum modelo com generateContent disponível.");
  cachedGeminiModel = picked;
  return cachedGeminiModel;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function geminiGenerate(content) {
  if (isGeminiDisabled()) {
    const e = new Error("gemini_disabled_temporarily"); e.code = "GEMINI_DISABLED"; throw e;
  }
  const apiKey = ENV.GEMINI_API_KEY || "";
  let model = await ensureGeminiModel(false);
  const body = Array.isArray(content)
    ? { contents: [{ parts: content }] }
    : { contents: [{ parts: [{ text: String(content || "") }] }] };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const resp = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";

    if (resp.status === 429) {
      console.error("❌ Gemini falhou (429): Rate Limit Esgotado.");
      const retryDelaySec = Number(String(data?.error?.details?.find?.((d) => d?.retryDelay)?.retryDelay || "").replace("s", "")) || 10;
      if (attempt === 1 && retryDelaySec <= 4) {
        await ensureGeminiModel(true); model = cachedGeminiModel; await sleep(retryDelaySec * 1000); continue;
      }
      disableGeminiFor(2 * 60 * 1000);
      const e = new Error("gemini_quota_exceeded"); e.code = 429; throw e;
    }
    const e = new Error(`generateContent failed: ${resp.status}`); e.code = resp.status; throw e;
  }
  return "";
}

// ===================================================
// CACHE DO CARDAPIOWEB (CATÁLOGO)
// ===================================================
let menuCache = { data: null, raw: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000;

async function getMenu() {
  if (menuCache.data && Date.now() - menuCache.timestamp < CACHE_TTL) return menuCache.data;

  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
  try {
    const resp = await fetch(`${base}/api/partner/v1/catalog`, {
      headers: {
        "X-API-KEY": ENV.CARDAPIOWEB_API_KEY || ENV.CARDAPIOWEB_TOKEN,
        "X-PARTNER-KEY": ENV.CARDAPIOWEB_PARTNER_KEY,
        Accept: "application/json"
      }
    });

    const data = await resp.json();
    if (!data?.categories) return "Cardápio indisponível.";

    let txt = "🍕 MENU PAPPI:\n";
    data.categories.forEach((cat) => {
      if (cat?.status === "ACTIVE") {
        txt += `\n[CATEGORIA: ${String(cat.name || "N/A").toUpperCase()}]\n`;
        (cat.items || []).forEach((i) => {
          if (i?.status === "ACTIVE") {
            const price = Number(i.price);
            txt += `- ID:${i.id} | ${i.name} | R$ ${Number.isFinite(price) ? price.toFixed(2) : "0.00"}\n`;
            if (i.options && i.options.length > 0) {
              i.options.forEach(opt => {
                if (opt.status === "ACTIVE") {
                  txt += `  -- Opção ID:${opt.id} | ${opt.name} | R$ ${Number(opt.price).toFixed(2)}\n`;
                }
              });
            }
          }
        });
      }
    });

    menuCache = { data: txt.trim(), raw: data, timestamp: Date.now() };
    return menuCache.data;
  } catch (e) {
    return "Cardápio indisponível.";
  }
}

// ===================================================
// LISTAS "BONITAS" DO CATÁLOGO (sem IDs) p/ evitar erro de item
// ===================================================
function normalizeTxt(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function catalogItemsFlat(raw) {
  const out = [];
  const cats = raw?.categories || [];
  for (const cat of cats) {
    if (cat?.status !== "ACTIVE") continue;
    for (const it of (cat.items || [])) {
      if (it?.status !== "ACTIVE") continue;
      out.push({
        category: String(cat.name || ""),
        id: it.id,
        name: String(it.name || ""),
        price: Number(it.price) || 0,
        raw: it,
      });
    }
  }
  return out;
}

function buildPrettyListFromCatalog(raw, { includeCategoriesRegex, limit = 10 } = {}) {
  if (!raw?.categories) return "";
  const rx = includeCategoriesRegex ? new RegExp(includeCategoriesRegex, "i") : null;
  const items = catalogItemsFlat(raw).filter(x => rx ? rx.test(x.category) : true);

  // ordena por nome para ficar estável
  items.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  const picked = items.slice(0, Math.max(1, limit));
  return picked.map(x => `- ${x.name}${Number.isFinite(x.price) && x.price > 0 ? ` — R$ ${x.price.toFixed(2)}` : ""}`).join("\n");
}

function buildSodasHint(raw) {
  // tenta achar categorias de bebidas/refrigerantes
  const list =
    buildPrettyListFromCatalog(raw, { includeCategoriesRegex: "bebida|refrigerante|refri|lata|2l|litro", limit: 12 }) ||
    "";
  return list ? `OPÇÕES DE BEBIDAS (escolha 1):\n${list}` : "";
}

function buildPizzaHint(raw) {
  const list =
    buildPrettyListFromCatalog(raw, { includeCategoriesRegex: "pizza|pizzas", limit: 12 }) ||
    "";
  return list ? `PIZZAS DO CARDÁPIO (escolha pelo nome certinho):\n${list}` : "";
}

// ===================================================
// Pagamentos (CORRETO) - merchant/payment_methods
// ===================================================
let paymentCache = { list: null, timestamp: 0 };

async function ensurePaymentMethods() {
  if (paymentCache.list && Date.now() - paymentCache.timestamp < CACHE_TTL) return paymentCache.list;
  const list = await getPaymentMethods().catch(() => []);
  paymentCache = { list, timestamp: Date.now() };
  return list;
}

function paymentsText(list) {
  // NUNCA expor ID pro cliente. Aqui é só pro prompt interno da IA, mas mesmo assim deixamos claro:
  if (!Array.isArray(list) || list.length === 0) return "PIX, Cartão, Dinheiro";
  return list.map(p => `${p.name} (${p.kind})`).join(" | ");
}

function pickPaymentId(list, preferredPayment) {
  if (!Array.isArray(list) || list.length === 0) return null;

  // kinds típicos: pix, money, credit_card, debit_card (varia, mas costuma ser isso)
  if (preferredPayment === "pix") {
    return (list.find(p => String(p.kind).toLowerCase() === "pix") || list[0])?.id ?? null;
  }
  if (preferredPayment === "dinheiro") {
    return (list.find(p => String(p.kind).toLowerCase() === "money") || list[0])?.id ?? null;
  }
  if (preferredPayment === "cartao") {
    return (
      list.find(p => String(p.kind).toLowerCase() === "credit_card") ||
      list.find(p => String(p.kind).toLowerCase() === "debit_card") ||
      list[0]
    )?.id ?? null;
  }
  return list[0]?.id ?? null;
}

// ===================================================
// Helper - Construtor de Endereço Cardápio Web (seguro)
// ===================================================
function buildDeliveryAddressObjectFromCustomer(customer, fallbackFormatted) {
  // Melhor: você salvar campos estruturados no banco.
  // Como hoje você salva apenas lastAddress, vamos preencher o mínimo e evitar CEP "00000000" quando possível.
  const cep = extractCep(customer?.lastAddress || "") || extractCep(fallbackFormatted || "") || null;

  return {
    state: "SP",
    city: "Campinas",
    neighborhood: customer?.lastNeighborhood || customer?.lastBairro || "Centro",
    street: customer?.lastStreet || "Rua não informada",
    number: customer?.lastNumber || "S/N",
    complement: customer?.lastComplement || "",
    reference: "",
    postal_code: cep || "00000000",
    coordinates: {
      latitude: Number(customer?.lastLat) || 0,
      longitude: Number(customer?.lastLng) || 0
    }
  };
}

// ===================================================
// Rotas básicas
// ===================================================
router.get("/", (req, res) => res.send("Pappi API IA online 🧠✅"));
router.get("/health", (req, res) => res.json({ ok: true, app: "Pappi Pizza IA" }));

// ===================================================
// WEBHOOK BANCO INTER (PIX)
// ===================================================
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
        await sendText(customer.phone, `✅ *Pagamento confirmado!* Recebemos R$ ${pag.valor}.\nSeu pedido foi enviado para o sistema e vai seguir para preparo. 🍕👨‍🍳`);

        if (order.cwJson) {
          try {
            const parsedData = JSON.parse(order.cwJson);
            const cwResp = await createOrder(parsedData);
            console.log("✅ Pedido injetado no Cardapio Web após PIX com sucesso!", cwResp?.id, cwResp?.status);
          } catch (e) {
            console.error("❌ Falha ao injetar pedido PIX no Cardapio Web:", e?.data || e);
          }
        }
      }
    }
  } catch (error) {
    console.error("🔥 Erro webhook Inter:", error);
  }
});

// ===================================================
// WEBHOOK PRINCIPAL (WhatsApp Cloud)
// ===================================================
router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;
  if (alreadyProcessed(msg.id)) return;

  const from = msg.from;

  try {
    let customer = await prisma.customer.findUnique({ where: { phone: from } }).catch(() => null);
    if (!customer) customer = await prisma.customer.create({ data: { phone: from } });

    if (isHandoffOn(from, customer)) return;

    // --------- INTERACTIVE (botões) ----------
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
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { lastFulfillment: v, lastInteraction: new Date() }
        }).catch(() => customer);
        pushHistory(from, "user", `BOTÃO: ${v}`);
      }

      if (btnId === "PAY_PIX" || btnId === "PAY_CARTAO" || btnId === "PAY_DINHEIRO") {
        const v = btnId === "PAY_PIX" ? "pix" : btnId === "PAY_CARTAO" ? "cartao" : "dinheiro";
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { preferredPayment: v, lastInteraction: new Date() }
        }).catch(() => customer);
        pushHistory(from, "user", `BOTÃO: pagamento ${v}`);
      }

      if (btnId === "ADDR_CONFIRM") {
        const af = getAF(from);
        const formatted = af?.pending?.formatted || null;

        if (formatted) {
          // salva endereço “final”
          await prisma.customer.update({
            where: { phone: from },
            data: { lastAddress: String(formatted).slice(0, 200), lastInteraction: new Date() }
          }).catch(() => null);

          pushHistory(from, "user", `ENDEREÇO CONFIRMADO: ${formatted}`);
        }

        resetAF(from);
        await sendText(from, "Fechado ✅ Agora me diga seu pedido 🍕 (tamanho + sabor, ou meia a meia)");
        return;
      }

      if (btnId === "ADDR_CORRECT") {
        resetAF(from);
        await sendText(from, "Me manda *CEP* ou *Rua + Número + Bairro* (ou sua localização 📍).");
        return;
      }

      if (!customer.name && !askedName.has(from)) {
        askedName.add(from);
        await sendText(from, "Show 😊 qual seu nome?");
        return;
      }
      if (!customer.lastFulfillment) { await askFulfillmentButtons(from); return; }
      if (customer.lastFulfillment === "entrega" && !customer.lastAddress) {
        await sendText(from, "Pra entrega, me manda *CEP* ou *Rua + Número + Bairro* (ou sua localização 📍) pra eu calcular a taxa 😊");
        return;
      }
      await sendText(from, "Fechado 🙌 Qual pizza você quer? (tamanho + sabor, ou meia a meia)");
      return;
    }

    // --------- LOCATION ----------
    if (msg.type === "location") {
      const lat = msg.location?.latitude;
      const lng = msg.location?.longitude;

      if (!lat || !lng) {
        await sendText(from, "Não consegui ler sua localização 😕 Manda de novo?");
        return;
      }

      if (!customer.lastFulfillment) {
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { lastFulfillment: "entrega", lastInteraction: new Date() }
        }).catch(() => customer);
      }

      const formatted = await reverseGeocodeLatLng(lat, lng);
      if (!formatted) {
        const fallback = `Localização recebida 📍 (GPS: ${lat}, ${lng})`;
        const af = getAF(from);
        af.pending = { formatted: fallback, lat, lng };
        await askAddressConfirm(from, fallback, null);
        return;
      }

      const deliveryGPS = await safeQuote(formatted);
      const af = getAF(from);
      af.pending = { formatted, lat, lng };
      af.delivery = deliveryGPS || null;

      if (deliveryGPS?.ok && deliveryGPS.within === false) {
        await sendText(from, `Ainda não entregamos aí (até ${MAX_KM} km). Quer *Retirada*?`);
        return;
      }

      await askAddressConfirm(from, formatted, deliveryGPS || null);
      return;
    }

    // --------- TEXT ----------
    if (msg.type !== "text") return;

    const userText = msg.text?.body || "";
    if (!userText) return;

    if (detectHumanRequest(userText) || detectIrritation(userText) || detectLoop(from)) {
      pushHistory(from, "user", userText);
      await sendText(from, "Entendi 🙏 desculpa a confusão. Vamos resolver agora.");
      await askDeescalationButtons(from);
      return;
    }

    const nm = extractNameLight(userText);
    const ff = detectFulfillmentLight(userText);
    const pay = detectPaymentLight(userText);

    const dataToUpdate = { lastInteraction: new Date() };
    if (nm && !customer.name && !looksLikeGarbageName(nm)) dataToUpdate.name = nm;
    if (ff) dataToUpdate.lastFulfillment = ff;
    if (pay) dataToUpdate.preferredPayment = pay;

    customer = await prisma.customer.update({ where: { phone: from }, data: dataToUpdate }).catch(() => customer);
    pushHistory(from, "user", userText);

    if (shouldAskName(from, customer) && /^(oi|olá|ola|sim|boa|boa noite|bom dia|boa tarde|menu)$/i.test(userText.trim())) {
      await sendText(from, "Pra eu te atender certinho 😊 me diz seu *nome*? (ex: Dony)");
      return;
    }

    if (!customer.name && nm && looksLikeGarbageName(nm)) {
      await sendText(from, "Me diz seu *nome* por favor? 😊 (ex: Dony)");
      return;
    }

    if (!customer.lastFulfillment) { await askFulfillmentButtons(from); return; }

    if (!looksLikeAddress(userText) && looksLikeOrderIntent(userText)) setDraft(from, userText);

    // -----------------------------------------
    // Fluxo endereço guiado (quando entrega sem endereço)
    // -----------------------------------------
    let currentFee = 0;

    if (customer.lastFulfillment === "entrega" && !customer.lastAddress) {
      const af = getAF(from);
      const t = String(userText || "").trim();

      if (!af.step && !looksLikeAddress(t) && looksLikeOrderIntent(userText)) {
        await sendText(from, "Pra entrega, me manda *CEP* ou *Rua + Número + Bairro* (ou sua localização 📍) pra eu calcular a taxa 😊");
        return;
      }

      const cep = extractCep(t);
      if (cep) { af.cep = cep; af.step = "ASK_NUMBER"; await sendText(from, "Perfeito ✅ Qual o *número* da casa?"); return; }

      if (af.step === "ASK_NUMBER") {
        const n = extractHouseNumber(t);
        if (!n) { await sendText(from, "Me diz só o *número* da casa 😊"); return; }
        af.number = n; af.step = "ASK_BAIRRO"; await sendText(from, "Boa! Qual o *bairro*?"); return;
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
        const d2 = await safeQuote(full);

        if (!d2?.ok) { af.pending = { formatted: full }; await askAddressConfirm(from, full, null); return; }
        if (d2.within === false) { await sendText(from, `Ainda não entregamos aí (até ${MAX_KM} km). Quer *Retirada*?`); return; }

        af.pending = { formatted: d2.formatted, lat: af.pending?.lat, lng: af.pending?.lng };
        await askAddressConfirm(from, d2.formatted, d2);
        return;
      }

      if (looksLikeAddress(t)) {
        const delivery = await safeQuote(t);
        if (delivery?.ok) {
          if (delivery.within === false) { await sendText(from, `Ainda não entregamos aí (até ${MAX_KM} km). Quer *Retirada*?`); return; }
          const formatted = delivery.formatted || t;
          const af2 = getAF(from);
          af2.pending = { formatted };
          await askAddressConfirm(from, formatted, delivery);
          return;
        }

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
    }

    // -----------------------------------------
    // taxa de entrega (se já tem endereço)
    // -----------------------------------------
    if (customer.lastFulfillment === "entrega" && customer.lastAddress) {
      const finalCota = await safeQuote(customer.lastAddress);
      currentFee = finalCota?.fee != null ? Number(finalCota.fee) : 0;
    }

    if (!customer.preferredPayment) {
      // se entrega sem endereço ainda, deixa fluir.
      if (!(customer.lastFulfillment === "entrega" && !customer.lastAddress)) {
        await askPaymentButtons(from);
        return;
      }
    }

    if (!customer.name) { await sendText(from, "Antes de continuar 😊 qual seu *nome*?"); return; }

    // ===================================================
    // Pega menu + pagamentos corretos
    // ===================================================
    const [menu, payList] = await Promise.all([getMenu(), ensurePaymentMethods()]);
    const pagamentosLoja = paymentsText(payList);

    const sodasHint = buildSodasHint(menuCache.raw);
    const pizzasHint = buildPizzaHint(menuCache.raw);

    // Obter CHAVE PIX do sistema
    const configPix = await prisma.config.findUnique({ where: { key: "CHAVE_PIX" } }).catch(() => null);
    const pixKey = configPix?.value || "19983193999";

    const mode = getMode({ customer, now: new Date() });
    const RULES = loadRulesFromFiles(mode); // mantém (mesmo se não usar direto aqui)
    const historyText = getHistoryText(from);
    const upsell = getUpsellHint({ historyText, userText });
    const pedidoTxt = getDraft(from)?.text || "";

    const disc = detectDISC(historyText, userText);
    const tone = discToneGuidance(disc);

    const paymentMethodIdPicked = pickPaymentId(payList, customer.preferredPayment);

    const deliveryInternal =
      customer.lastFulfillment === "entrega"
        ? `ENTREGA (interno): Taxa atual R$ ${Number(currentFee).toFixed(2)}`
        : `RETIRADA (interno): sem taxa`;

    const etaTxt =
      customer.lastFulfillment === "entrega"
        ? "Tempo estimado: 40 a 60 minutos."
        : "Tempo estimado: 30 a 40 minutos.";

    // ===================================================
    // PROMPT
    // ===================================================
    const PROMPT = `
Você atende como humano da Pappi Pizza (Campinas-SP). Não diga que é robô. Fale natural e simpático.
${tone}

REGRAS DE ATENDIMENTO (MUITO IMPORTANTE):
- Já sabemos: Nome: ${customer.name || "(não informado)"} | Envio: ${customer.lastFulfillment || "(não definido)"} | Pagamento: ${customer.preferredPayment || "(não definido)"}
- Taxa de entrega (se entrega): R$ ${Number(currentFee).toFixed(2)}
- PROIBIDO FALAR IDs: NUNCA diga os códigos dos produtos (ex: "ID:123") para o cliente na conversa. IDs são só para preencher o JSON final.
- NUNCA INVENTAR ITEM: Se não tiver certeza absoluta que o item existe no CARDÁPIO, você deve pedir para o cliente escolher pelo nome exato do cardápio (usar lista abaixo) ou mandar o link do cardápio.
- SABORES GENÉRICOS: Se o cliente pedir "frango com catupiry" e não existir exatamente assim no cardápio, mostre as opções reais do cardápio e peça para escolher UMA delas pelo nome exato.
- BEBIDAS: Se o cliente pedir "coca", mostre a lista de bebidas disponíveis e peça para ele escolher qual (ex: 2L, lata, etc).
- MEIO A MEIO: Pode. Você calcula o total do pedido corretamente no JSON final. **NUNCA explique ao cliente que é "o sabor mais caro"**. Apenas informe o valor final.
- STATUS DO PEDIDO: Você NÃO pode dizer "motoboy a caminho" nem "pedido confirmado" sem retorno do sistema. Após o cliente confirmar o resumo, diga apenas:
  "Pedido registrado no sistema e seguindo para confirmação/preparo. Você receberá atualizações do status."
- TEMPO: Sempre informar ${etaTxt}
- 1 pergunta por vez.

ROTEIRO:
1) Confirme tamanho + sabores (se meio a meio, confirmar os 2 sabores pelo nome exato do cardápio)
2) Ofereça borda + bebida (quando fizer sentido)
3) Pergunte observações
4) Se dinheiro, pergunte troco
5) Faça resumo e total exato (inclui taxa R$ ${Number(currentFee).toFixed(2)})
6) Pergunte "Podemos confirmar?" (sem falar de motoboy)

FINALIZAÇÃO:
Quando o cliente disser SIM/CONFIRMAR para o resumo, gere um bloco JSON final dentro de \`\`\`json.

Formato:
\`\`\`json
{
  "order_confirmation": true,
  "order_type": "${customer.lastFulfillment === 'entrega' ? 'delivery' : 'takeout'}",
  "observation": "Observações do cliente",
  "total_order_amount": VALOR_TOTAL_NUMERICO,
  "delivery_fee": ${customer.lastFulfillment === 'entrega' ? Number(currentFee).toFixed(2) : 0},
  "payment_method_id": ${paymentMethodIdPicked ?? "ID_INTEIRO_DO_PAGAMENTO"},
  "change_for": VALOR_TROCO_OU_NULL,
  "items": [
    {
      "item_id": "ID_DO_PRODUTO",
      "name": "NOME",
      "quantity": 1,
      "unit_price": PRECO_UNITARIO,
      "observation": "obs do item",
      "options": [
        {
          "option_id": "ID_DA_OPCAO",
          "name": "NOME DA OPCAO",
          "quantity": 1,
          "unit_price": PRECO_DA_OPCAO
        }
      ]
    }
  ]
}
\`\`\`

PAGAMENTOS DISPONÍVEIS (não mostrar IDs pro cliente):
${pagamentosLoja}

${deliveryInternal}

LISTAS PARA AJUDAR O CLIENTE A ESCOLHER (sem IDs):
${pizzasHint || ""}
${sodasHint || ""}

LINK DO CARDÁPIO (se precisar obrigar escolha):
${LINK_CARDAPIO}

CARDÁPIO (IDs e preços reais - USO INTERNO):
${menu}

HISTÓRICO:
${historyText}
`.trim();

    const content = `${PROMPT}\n\nCliente: ${userText}\nAtendente:`;
    let resposta = "";

    try {
      resposta = await geminiGenerate(content);
    } catch (e) {
      console.error("❌ Gemini falhou definitivamente:", e?.message || e);
      await sendText(from, "Estou com muitas mensagens agora 😅 Me diga apenas o *tamanho* e os *sabores* da pizza que quer pedir, por favor. (Menu: " + LINK_CARDAPIO + ")");
      return;
    }

    // ===================================================
    // EXTRAÇÃO DO JSON DA IA
    // ===================================================
    let jsonMatch = resposta.match(/```json([\s\S]*?)```/);
    let orderDataFromIA = null;

    if (jsonMatch && jsonMatch[1]) {
      try {
        orderDataFromIA = JSON.parse(jsonMatch[1].trim());
        resposta = resposta.replace(jsonMatch[0], "").trim();
      } catch (e) {
        console.error("Erro ao fazer parse do JSON da IA:", e);
      }
    }

    let finalOrderPayload = null;
    let txid = `PAPPI${Date.now()}`;

    // ===================================================
    // Se IA confirmou: montar payload final Cardápio Web
    // ===================================================
    if (orderDataFromIA && orderDataFromIA.order_confirmation === true) {
      let itemsFormatados = [];
      let sumItems = 0;

      if (Array.isArray(orderDataFromIA.items)) {
        itemsFormatados = orderDataFromIA.items.map(item => {
          let optionsSum = 0;
          let optionsFormatted = [];

          if (item.options && Array.isArray(item.options)) {
            optionsFormatted = item.options.map(opt => {
              const optPrice = parseFloat(opt.unit_price) || 0;
              const optQty = parseInt(opt.quantity) || 1;
              optionsSum += (optPrice * optQty);
              return {
                name: opt.name,
                quantity: optQty,
                unit_price: optPrice,
                option_id: opt.option_id ? String(opt.option_id) : undefined
              };
            });
          }

          const basePrice = parseFloat(item.unit_price) || 0;
          const qty = parseInt(item.quantity) || 1;

          const totalPriceItem = (basePrice + optionsSum) * qty;
          sumItems += totalPriceItem;

          return {
            name: item.name,
            quantity: qty,
            unit_price: basePrice,
            total_price: totalPriceItem,
            item_id: item.item_id ? String(item.item_id) : undefined,
            observation: item.observation || "",
            options: optionsFormatted.length > 0 ? optionsFormatted : undefined
          };
        });
      }

      const deliveryFee = customer.lastFulfillment === "entrega" ? Number(currentFee) : 0;
      const totalCalculado = Number(sumItems) + Number(deliveryFee);

      const pmId = parseInt(orderDataFromIA.payment_method_id) || paymentMethodIdPicked || null;

      if (!pmId) {
        await sendText(from, "Só mais uma coisa 😊 qual forma de pagamento você prefere?");
        await askPaymentButtons(from);
        return;
      }

      finalOrderPayload = {
        order_id: txid,
        display_id: txid.replace("PAPPI", ""),
        order_type: orderDataFromIA.order_type || (customer.lastFulfillment === "entrega" ? "delivery" : "takeout"),
        observation: orderDataFromIA.observation || "Pedido via Assistente WhatsApp",
        customer: {
          phone: digitsOnly(from),
          name: customer.name || "Cliente WhatsApp"
        },
        totals: {
          order_amount: totalCalculado,
          delivery_fee: deliveryFee,
          additional_fee: 0.0,
          discounts: 0.0
        },
        items: itemsFormatados,
        payments: [
          {
            total: totalCalculado,
            payment_method_id: pmId,
            change_for: orderDataFromIA.change_for ? parseFloat(orderDataFromIA.change_for) : undefined
          }
        ]
      };

      if (finalOrderPayload.order_type === "delivery") {
        finalOrderPayload.delivery_address = buildDeliveryAddressObjectFromCustomer(customer, customer.lastAddress);
      }
    }

    // ===================================================
    // Se tem payload final: PIX vs Cartão/Dinheiro
    // ===================================================
    if (finalOrderPayload) {
      if (customer.preferredPayment === "pix") {
        const pixData = await createPixCharge(txid, finalOrderPayload.totals.order_amount, customer.name || "Cliente Pappi");

        if (pixData?.pixCopiaECola) {
          await prisma.order.create({
            data: {
              displayId: txid,
              status: "waiting_payment",
              total: finalOrderPayload.totals.order_amount,
              items: "Aguardando pagamento PIX",
              customerId: customer.id,
              cwJson: JSON.stringify(finalOrderPayload)
            },
          });

          if (resposta) await sendText(from, resposta);

          const qrCodeUrl = `https://quickchart.io/qr?size=300&text=${encodeURIComponent(pixData.pixCopiaECola)}`;
          await sendImage(from, qrCodeUrl, "QR Code PIX ✅");
          await sendText(from, `Copia e Cola:\n${pixData.pixCopiaECola}\n\nAssim que o pagamento cair, o pedido é registrado no sistema e segue para preparo. ✅\n${etaTxt}`);

          clearDraft(from);
          pushHistory(from, "assistant", "[PIX GERADO - AGUARDANDO PAGAMENTO PARA ENVIAR AO SISTEMA]");
          return;
        }

        await sendText(from, `Tive um problema ao gerar o QR Code 😅\nPode enviar para a Chave PIX: ${pixKey} e mandar o comprovante?`);
        return;
      }

      // Dinheiro ou cartão: cria pedido direto
      try {
        const cwResp = await createOrder(finalOrderPayload);

        await prisma.order.create({
          data: {
            displayId: txid,
            status: "waiting_confirmation",
            total: finalOrderPayload.totals.order_amount,
            items: "Pedido Dinheiro/Cartao",
            customerId: customer.id
          },
        });

        if (resposta) await sendText(from, resposta);

        // Mensagem correta: sem "motoboy a caminho"
        await sendText(from,
          `✅ *Pedido registrado no sistema!* Agora ele segue para confirmação/preparo.\n${etaTxt}\nVocê vai receber atualizações do status por aqui. 🍕`
        );

        clearDraft(from);
        pushHistory(from, "assistant", `[PEDIDO CRIADO NO SISTEMA] cw_id=${cwResp?.id || "?"} status=${cwResp?.status || "waiting_confirmation"}`);
        return;

      } catch (error) {
        console.error("Falha ao enviar pedido para Cardapio Web:", error?.status, error?.data || error);
        await sendText(from, "Tive um erro ao registrar o seu pedido no sistema 😕 Vou chamar um humano pra confirmar com você agora!");
        await setHandoffOn(from);
        return;
      }
    }

    // Se IA não confirmou ainda, conversa normal
    pushHistory(from, "assistant", resposta);
    await sendText(from, resposta);

  } catch (error) {
    console.error("🔥 Erro Fatal Webhook:", error);
    await sendText(from, `Deu uma instabilidade 😅\nMe diz *tamanho* e *sabor* da pizza? (ou peça aqui: ${LINK_CARDAPIO})`);
  }
});

module.exports = router;
