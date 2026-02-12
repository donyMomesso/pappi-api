/**
 * Pappi Pizza API - Versão Final com Checkout e Botões
 * WhatsApp Cloud + Cardápio Web + DigiSac
 */

const express = require("express");
const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== CONFIGURAÇÕES (Ambiente Render) =====
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "";
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN || "";
const CARDAPIOWEB_STORE_ID = process.env.CARDAPIOWEB_STORE_ID || "";
const CARDAPIOWEB_BASE_URL = "https://integracao.cardapioweb.com";

// ===== MEMÓRIA DE SESSÃO =====
const SESSIONS = new Map();

function getSession(phone) {
  if (!SESSIONS.has(phone)) {
    SESSIONS.set(phone, {
      step: "start",
      channel: null,
      address: null,
      cart: [],
      tempProduct: null,
      lastSeen: Date.now()
    });
  }
  return SESSIONS.get(phone);
}

function normalize(str) {
  return (str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// ===== INTEGRAÇÃO CARDÁPIO WEB (API DE PEDIDOS) =====

async function cardapioWebAPI(path, method = "GET", body = null) {
  const url = `${CARDAPIOWEB_BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      "X-API-KEY": CARDAPIOWEB_TOKEN,
      "Content-Type": "application/json",
    }
  };
  if (body) options.body = JSON.stringify(body);

  const resp = await fetch(url, options);
  return await resp.json();
}

async function finalizarPedidoNoCardapioWeb(session, phone) {
  const orderData = {
    store_id: CARDAPIOWEB_STORE_ID,
    customer: { name: "Cliente WhatsApp", phone: phone },
    items: session.cart.map(item => ({ product_id: item.product_id, quantity: 1 })),
    delivery_type: session.channel,
    address: session.channel === "delivery" ? { street: session.address } : null,
    payment_method: "A combinar"
  };
  return await cardapioWebAPI("/orders", "POST", orderData);
}

// ===== WHATSAPP ENGINE (BOTÕES) =====

async function sendWhatsAppButtons(toNumber, textBody, buttons) {
  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const formattedButtons = buttons.slice(0, 3).map((btn, i) => ({
    type: "reply", reply: { id: `btn_${i}`, title: btn }
  }));

  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toNumber,
      type: "interactive",
      interactive: { type: "button", body: { text: textBody }, action: { buttons: formattedButtons } }
    }),
  });
}

// ===== LÓGICA DO WEBHOOK =====

app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === WEBHOOK_VERIFY_TOKEN) res.status(200).send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const entry = req.body.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  if (!message) return;

  const phone = message.from;
  const text = message.text?.body || message.interactive?.button_reply?.title || "";
  const t = normalize(text);
  const session = getSession(phone);

  // MENU INICIAL (ENTREGA, RETIRA, OUTROS)
  if (session.step === "start" || t === "oi" || t === "ola" || t === "voltar") {
    session.step = "ask_channel";
    await sendWhatsApp
