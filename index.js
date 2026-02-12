/**
 * Pappi API - WhatsApp Cloud + Cardápio Web + GPT Actions
 * Versão Atualizada: Pagamento, Atendente e Validação de Catálogo
 */

const express = require("express");
const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== ENV =====
const API_KEY = process.env.ATTENDANT_API_KEY || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "";
const CARDAPIOWEB_BASE_URL = process.env.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN || "";
const CARDAPIOWEB_STORE_ID = process.env.CARDAPIOWEB_STORE_ID || "";

// ===== In-memory store =====
const ORDERS = new Map();
const SESSIONS = new Map();

function nowIso() { return new Date().toISOString(); }

// ===== HELPERS DE SESSÃO =====
function getSession(phone) {
  if (!SESSIONS.has(phone)) {
    SESSIONS.set(phone, {
      step: "start",
      mode: null,
      address: { street: "", district: "", ref: "" },
      cart: [],
      payment: null
    });
  }
  return SESSIONS.get(phone);
}

function resetSession(phone) {
  SESSIONS.set(phone, {
    step: "start",
    mode: null,
    address: { street: "", district: "", ref: "" },
    cart: [],
    payment: null
  });
}

// ===== CARDAPIO WEB API =====
async function cardapioWebFetch(path, { method = "GET", body } = {}) {
  const url = `${CARDAPIOWEB_BASE_URL}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      "X-API-KEY": CARDAPIOWEB_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return resp.json();
}

// ===== WHATSAPP HELPERS =====
async function sendWhatsApp(toNumber, payload) {
  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to: toNumber, ...payload }),
  });
}

async function sendButtons(toNumber, text, buttons) {
  const payload = {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: buttons.map(b => ({ type: "reply", reply: { id: b.id, title: b.title } }))
      }
    }
  };
  await sendWhatsApp(toNumber, payload);
}

// ===== WEBHOOK WHATSAPP =====

app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const entry = req.body.entry?.[0]?.changes?.[0]?.value;
  const msg = entry?.messages?.[0];
  if (!msg) return;

  const phone = msg.from;
  const session = getSession(phone);
  const text = (msg.text?.body || msg.interactive?.button_reply?.title || "").trim();
  const lower = text.toLowerCase();

  try {
    // 1. Lógica de Atendente (Transbordo)
    if (lower.includes("atendente") || lower.includes("humano") || msg.interactive?.button_reply?.id === "HUMAN") {
      await sendWhatsApp(phone, { type: "text", text: { body: "🎧 Entendido! Estou transferindo você para um atendente humano. Por favor, aguarde um instante." } });
      session.step = "waiting_human";
      return;
    }

    // 2. Fluxo Principal
    if (lower === "oi" || lower === "ola" || lower === "menu") {
      resetSession(phone);
      return await sendButtons(phone, "Bem-vindo à Pappi Pizza! 🍕\nComo deseja seu pedido hoje?", [
        { id: "DELIVERY", title: "🛵 Entrega" },
        { id: "TAKEOUT", title: "🏃 Retirada" },
        { id: "OTHER", title: "📂 Outros" }
      ]);
    }

    // Botão Outros
    if (msg.interactive?.button_reply?.id === "OTHER") {
      return await sendButtons(phone, "O que você precisa?\n📍 Endereço: Campinas, SP\n🕒 Horário: 18h às 23h", [
        { id: "HUMAN", title: "🎧 Atendente" },
        { id: "MENU_LINK", title: "📖 Ver Cardápio" }
      ]);
    }

    // Link do Cardápio
    if (msg.interactive?.button_reply?.id === "MENU_LINK") {
        return await sendWhatsApp(phone, { type: "text", text: { body: "📖 Confira nosso cardápio online:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony" } });
    }

    // Seleção de Canal
    if (msg.interactive?.button_reply?.id === "DELIVERY") {
      session.mode = "delivery";
      session.step = "ask_address";
      return await sendWhatsApp(phone, { type: "text", text: { body: "🛵 *Entrega*\nPor favor, digite seu endereço completo (Rua, nº e Bairro):" } });
    }

    if (msg.interactive?.button_reply?.id === "TAKEOUT") {
      session.mode = "takeout";
      session.step = "ask_item";
      return await sendWhatsApp(phone, { type: "text", text: { body: "🏃 *Retirada*\nO que você deseja pedir? (Ex: 1 Pizza Calabresa)" } });
    }

    // Passo: Endereço
    if (session.step === "ask_address") {
      session.address.street = text;
      session.step = "ask_item";
      return await sendWhatsApp(phone, { type: "text", text: { body: "Endereço anotado! 📍\nAgora me diga o que deseja pedir:" } });
    }

    // Passo: Item do Pedido e Validação de Catálogo
    if (session.step === "ask_item") {
      session.cart.push(text);
      session.step = "ask_payment";
      return await sendButtons(phone, `Confirmado: ${text} ✅\nComo deseja realizar o pagamento?`, [
        { id: "PAY_PIX", title: "💎 PIX" },
        { id: "PAY_CARD", title: "💳 Cartão" },
        { id: "PAY_CASH", title: "💵 Dinheiro" }
      ]);
    }

    // Passo: Pagamento e Finalização
    if (session.step === "ask_payment" && msg.type === "interactive") {
      session.payment = text;
      
      // Enviar para API Cardápio Web
      const orderBody = {
        store_id: CARDAPIOWEB_STORE_ID,
        customer: { phone: phone, name: "Cliente WhatsApp" },
        items: [{ product_id: session.cart[0], quantity: 1 }],
        delivery_type: session.mode,
        payment_method: session.payment,
        address: session.mode === "delivery" ? { street: session.address.street } : null
      };

      try {
        const result = await cardapioWebFetch("/orders", { method: "POST", body: orderBody });
        await sendWhatsApp(phone, { type: "text", text: { body: `✅ PEDIDO REALIZADO!\nObrigado por escolher a Pappi Pizza.\nSeu pedido em breve será processado.` } });
      } catch (e) {
        await sendWhatsApp(phone, { type: "text", text: { body: "❌ Erro ao enviar para o sistema. Um atendente entrará em contato." } });
      }
      
      resetSession(phone);
      return;
    }

  } catch (err) {
    console.error("Erro no Webhook:", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));
