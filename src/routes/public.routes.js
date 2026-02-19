const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

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
// IA (Gemini)
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
  if (!resp.ok) throw new Error(`generateContent failed: ${resp.status}`);

  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
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
    image: { link: imageUrl, caption: caption }
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
// ADDRESS FLOW
// ===============================
const addressFlow = new Map(); 

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
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${ENV.GOOGLE_MAPS_API_KEY}&language=pt-BR&result_type=street_address|premise|subpremise|route`;
  const resp = await fetch(url).catch(() => null);
  const data = await resp?.json().catch(() => null);
  return data?.results?.[0]?.formatted_address || null;
}

async function askAddressConfirm(to, formatted, delivery) {
  const feeTxt = delivery?.fee != null ? `R$ ${Number(delivery.fee).toFixed(2)}` : "a confirmar";
  const kmTxt = Number.isFinite(delivery?.km) ? `${delivery.km.toFixed(1)} km` : "";
  const txt = `Achei este endereço 📍:\n*${formatted}*\nTaxa: *${feeTxt}*${kmTxt ? ` | ${kmTxt}` : ""}\n\nEstá certo?`;
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
    const metaResp = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, { headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` } });
    const meta = await metaResp.json();
    if (!meta?.url) return null;
    const mediaResp = await fetch(meta.url, { headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` } });
    const mimeType = mediaResp.headers.get("content-type") || "audio/ogg";
    const buffer = await mediaResp.arrayBuffer();
    return { base64: Buffer.from(buffer).toString("base64"), mimeType };
  } catch (e) { return null; }
}

async function transcribeAndExtractFromAudio(base64, mimeType) {
  const PROMPT_AUDIO = `Você é atendente da Pappi Pizza. TRANSCRAVA o áudio e EXTRAIA campos em JSON...`;
  const parts = [{ text: PROMPT_AUDIO }, { inlineData: { data: base64, mimeType: mimeType || "audio/ogg" } }];
  const raw = await geminiGenerate(parts);
  try { return JSON.parse(String(raw || "").replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim()); } 
  catch { return { transcription: String(raw || "").trim() }; }
}

// ===============================
// CARDAPIOWEB
// ===============================
async function getMenu() {
  const base = ENV.CARDAPIOWEB_BASE_URL || "[https://integracao.cardapioweb.com](https://integracao.cardapioweb.com)";
  const url = `${base}/api/partner/v1/catalog`;
  try {
    const resp = await fetch(url, { headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, Accept: "application/json" } });
    const data = await resp.json();
    if (!data?.categories) return "Cardápio indisponível.";
    let txt = "🍕 MENU PAPPI PIZZA:\n";
    data.categories.forEach((cat) => {
      if (cat?.status === "ACTIVE") {
        txt += `\n${String(cat.name).toUpperCase()}\n`;
        (cat.items || []).forEach((i) => { if (i?.status === "ACTIVE") txt += `- ${i.name} (R$ ${Number(i.price).toFixed(2)})\n`; });
      }
    });
    return txt.trim();
  } catch (e) { return "Cardápio indisponível."; }
}

async function getMerchant() {
  const base = ENV.CARDAPIOWEB_BASE_URL || "[https://integracao.cardapioweb.com](https://integracao.cardapioweb.com)";
  try {
    const resp = await fetch(`${base}/api/partner/v1/merchant`, { headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, Accept: "application/json" } });
    return await resp.json();
  } catch (e) { return null; }
}

function normalizePayments(merchant) {
  const raw = merchant?.métodos_de_pagamento || merchant?.payment_methods || null;
  if (!Array.isArray(raw)) return "PIX, Cartão e Dinheiro";
  const names = raw.filter((p) => p && (p.ativo === true || p.status === "ACTIVE")).map((p) => p.name || p.method);
  return names.length ? names.join(", ") : "PIX, Cartão e Dinheiro";
}

function normalizeAddress(merchant) {
  const addr = merchant?.endereço || merchant?.address || null;
  if (!addr) return "Campinas-SP";
  const parts = [addr.rua || addr.street, addr.numero || addr.number, addr.bairro || addr.district].filter(Boolean);
  return parts.join(", ") || "Campinas-SP";
}

// ===============================
// EXTRAÇÃO SIMPLES
// ===============================
function extractNameLight(text) {
  const t = String(text || "").trim();
  const m = t.match(/(?:meu nome é|aqui é o|aqui é a|sou o|sou a|me chamo)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2})/i); 
  return m?.[1]?.trim()?.slice(0, 60) || null;
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
            if (order) {
                await prisma.order.update({ where: { id: order.id }, data: { status: "confirmed" } });
                const customer = await prisma.customer.findUnique({ where: { id: order.customerId } });
                if (customer) {
                    await sendText(customer.phone, `✅ *Pagamento Confirmado!* Recebemos o seu PIX de R$ ${pag.valor}.\nA sua pizza já foi enviada para a cozinha! 🍕👨‍🍳`);
                }
            }
        }
    } catch (error) { console.error("🔥 Erro no webhook do Inter:", error); }
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
    let customer = await prisma.customer.findUnique({ where: { phone: from } }).catch(() => null);
    if (!customer) customer = await prisma.customer.create({ data: { phone: from } });

    // Botões
    if (msg.type === "interactive") {
      const btnId = msg?.interactive?.button_reply?.id || null;
      if (btnId === "FULFILLMENT_ENTREGA" || btnId === "FULFILLMENT_RETIRADA") {
        const v = btnId === "FULFILLMENT_ENTREGA" ? "entrega" : "retirada";
        customer = await prisma.customer.update({ where: { phone: from }, data: { lastFulfillment: v, lastInteraction: new Date() }});
        pushHistory(from, "user", `BOTÃO: ${v}`);
      }
      if (btnId === "PAY_PIX" || btnId === "PAY_CARTAO" || btnId === "PAY_DINHEIRO") {
        const v = btnId === "PAY_PIX" ? "pix" : btnId === "PAY_CARTAO" ? "cartao" : "dinheiro";
        customer = await prisma.customer.update({ where: { phone: from }, data: { preferredPayment: v, lastInteraction: new Date() }});
        pushHistory(from, "user", `BOTÃO: pagamento ${v}`);
      }
      if (btnId === "ADDR_CONFIRM") {
        const af = getAF(from);
        if (af?.pending?.formatted) {
          await prisma.customer.update({ where: { phone: from }, data: { lastAddress: af.pending.formatted, lastInteraction: new Date() }});
          pushHistory(from, "user", `ENDEREÇO CONFIRMADO: ${af.pending.formatted}`);
        }
        resetAF(from);
        await sendText(from, "Perfeito ✅ Endereço confirmado! Agora me diga seu pedido 🍕");
        return;
      }
      if (btnId === "ADDR_CORRECT") {
        resetAF(from);
        await sendText(from, "Sem problema 😊 Me mande *Rua e Número* (ou *CEP*) pra eu calcular certinho.");
        return;
      }
    }

    // Texto, Áudio, Localização
    let userText = "";
    let extracted = null;

    if (msg.type === "audio") {
      const audio = await downloadAudio(msg.audio?.id);
      if (audio?.base64) {
        extracted = await transcribeAndExtractFromAudio(audio.base64, audio.mimeType);
        userText = `ÁUDIO TRANSCRITO: ${extracted.transcription || ""}`.trim();
      } else {
        await sendText(from, "Não consegui ouvir esse áudio 😕");
        return;
      }
    } else if (msg.type === "text") {
      userText = msg.text?.body || "";
    } else if (msg.type === "location") {
      const { latitude, longitude } = msg.location;
      await prisma.customer.update({ where: { phone: from }, data: { lastInteraction: new Date() }});
      if (!customer.lastFulfillment) await prisma.customer.update({ where: { phone: from }, data: { lastFulfillment: "entrega" }});
      
      const formatted = await reverseGeocodeLatLng(latitude, longitude);
      if (!formatted) { await sendText(from, "Não consegui achar esse endereço no mapa 😕"); return; }
      
      const deliveryGPS = await quoteAny(formatted);
      if (!deliveryGPS?.ok) { await sendText(from, "Confirma se a localização está certa?"); return; }

      const af = getAF(from);
      af.pending = { formatted, lat: latitude, lng: longitude };
      af.delivery = deliveryGPS;
      await askAddressConfirm(from, formatted, deliveryGPS);
      return;
    }

    if (!userText && msg.type !== "interactive") return;

    if (userText) {
      const dataToUpdate = {};
      const nm = extractNameLight(userText);
      const ff = detectFulfillmentLight(userText);
      const pay = detectPaymentLight(userText);
      if (nm && !customer.name) dataToUpdate.name = nm;
      if (ff) dataToUpdate.lastFulfillment = ff;
      if (pay) dataToUpdate.preferredPayment = pay;
      if (Object.keys(dataToUpdate).length) await prisma.customer.update({ where: { phone: from }, data: dataToUpdate });
    }

    if (extracted) {
      const dataToUpdate = {};
      if (extracted.customer_name && !customer.name) dataToUpdate.name = extracted.customer_name;
      if (extracted.delivery_or_pickup) dataToUpdate.lastFulfillment = extracted.delivery_or_pickup;
      if (extracted.payment) dataToUpdate.preferredPayment = extracted.payment;
      if (Object.keys(dataToUpdate).length) await prisma.customer.update({ where: { phone: from }, data: dataToUpdate });
    }

    if (userText) pushHistory(from, "user", userText);

    if (!customer.lastFulfillment) { await askFulfillmentButtons(from); return; }
    if (!customer.preferredPayment) { await askPaymentButtons(from); return; }

    // Address Flow
    if (customer.lastFulfillment === "entrega" && msg.type === "text") {
      const af = getAF(from);
      const t = String(userText).trim();
      const cep = extractCep(t);
      
      if (cep) { af.cep = cep; af.step = "ASK_NUMBER"; await sendText(from, "Perfeito ✅ Qual o *número* da casa?"); return; }

      if (af.step === "ASK_NUMBER") {
        const n = extractHouseNumber(t);
        if (!n) { await sendText(from, "Me diz só o *número* da casa 😊"); return; }
        af.number = n; af.step = "ASK_BAIRRO"; await sendText(from, "Boa! Qual o *bairro*?"); return;
      }
      if (af.step === "ASK_BAIRRO") {
        af.bairro = t.slice(0, 80); af.step = "ASK_COMPLEMENTO"; await sendText(from, "Tem *complemento*? Se não tiver, diga *sem*."); return;
      }
      if (af.step === "ASK_COMPLEMENTO") {
        af.complemento = looksLikeNoComplement(t) ? null : t.slice(0, 120);
        af.step = null;
        const full = buildAddressText(af);
        const d2 = await quoteAny(full);
        if (!d2?.ok) { await sendText(from, "Quase lá 😅 Pode mandar o endereço completo?"); return; }
        af.pending = { formatted: d2.formatted };
        await askAddressConfirm(from, d2.formatted, d2);
        return;
      }
    }

    let deliveryInternal = `ENTREGA (interno): não aplicável`;
    if (customer.lastFulfillment === "entrega") {
      const delivery = await quoteAny(extracted?.address_text || userText);
      if (delivery?.ok) {
        if (delivery.formatted) await prisma.customer.update({ where: { phone: from }, data: { lastAddress: delivery.formatted } });
        if (delivery.within === false) { await sendText(from, `Ainda não entregamos aí (até ${MAX_KM} km). Pode *retirar*?`); return; }
        deliveryInternal = `ENTREGA (interno): ${delivery.km.toFixed(1)} km | Taxa: R$ ${delivery.fee}`;
      } else {
        // Se não achou endereço E não estamos no fluxo guiado
        const af = getAF(from);
        if (!af.step && !af.pending) {
           // Inicia fluxo guiado se não achar de cara
           const cep = extractCep(userText);
           if (cep) { af.cep = cep; af.step = "ASK_NUMBER"; await sendText(from, "Qual o *número* da casa?"); return; }
           // Se nem CEP achou, pode ser só "oi", então não trava o fluxo.
        }
      }
    }

    // Cérebro da IA
    const [menu, merchant, configPix] = await Promise.all([getMenu(), getMerchant(), prisma.config.findUnique({ where: { key: "CHAVE_PIX" } }).catch(() => null)]);
    const enderecoLoja = normalizeAddress(merchant);
    const pagamentosLoja = normalizePayments(merchant);
    const pixKey = configPix?.value || "19 9 8319 3999";
    const mode = getMode({ customer, now: new Date() });
    const RULES = loadRulesFromFiles(mode);
    const historyText = getHistoryText(from);
    const upsell = getUpsellHint({ historyText, userText });

    const PROMPT = `
Você é o atendente virtual da Pappi Pizza (Campinas-SP).
Tom: caloroso, simpático e objetivo.
REGRAS CRÍTICAS:
- NUNCA diga: "VIP", "modo", "evento", "interno".
- Já sabemos: Nome: ${customer.name || "?"} | Envio: ${customer.lastFulfillment} | Pagamento: ${customer.preferredPayment}
- Se o cliente FINALIZAR O PEDIDO e o pagamento for PIX, coloque no final: [GERAR_PIX:valor]. Ex: [GERAR_PIX:57.90]
- Sempre finalize com 1 pergunta clara.

DADOS DA LOJA:
- Endereço: ${enderecoLoja}
- Pagamentos: ${pagamentosLoja}
- PIX: ${pixKey}
- Cardápio: ${LINK_CARDAPIO}
${deliveryInternal}
CARDÁPIO:
${menu}
HISTÓRICO:
${historyText}
UPSELL: ${upsell || "NENHUM"}
`.trim();

    const content = `${PROMPT}\n\nCliente: ${userText}\nAtendente:`;
    let resposta = await geminiGenerate(content);

    // PIX INTERCEPT
    const pixMatch = resposta.match(/\[GERAR_PIX:(\d+\.\d{2})\]/);
    if (pixMatch) {
        const valorTotal = parseFloat(pixMatch[1]);
        resposta = resposta.replace(pixMatch[0], "").trim(); 
        await sendText(from, resposta);

        const txid = `PAPPI${Date.now()}`; 
        const pixData = await createPixCharge(txid, valorTotal, customer.name || "Cliente Pappi");

        if (pixData && pixData.pixCopiaECola) {
            await prisma.order.create({ data: { displayId: txid, status: "waiting_payment", total: valorTotal, items: "Pedido WhatsApp", customerId: customer.id } });
            const qrCodeUrl = `https://quickchart.io/qr?size=300&text=${encodeURIComponent(pixData.pixCopiaECola)}`;
            await sendImage(from, qrCodeUrl, "📷 Seu QR Code!");
            await sendText(from, `Copia e Cola:\n\n${pixData.pixCopiaECola}`);
        } else {
            await sendText(from, "Erro no QR Code. Use a chave: 19 9 8319 3999");
        }
        pushHistory(from, "assistant", resposta);
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
