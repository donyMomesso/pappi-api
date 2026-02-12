const express = require("express");
const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== CONFIGURAÇÕES (ENV) =====
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
      channel: null, // 'delivery' ou 'takeaway'
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

// Função para enviar o pedido completo conforme a documentação solicitada
async function finalizarPedidoNoCardapioWeb(session, phone) {
  const orderData = {
    store_id: CARDAPIOWEB_STORE_ID,
    customer: {
      name: "Cliente WhatsApp",
      phone: phone
    },
    items: session.cart.map(item => ({
      product_id: item.product_id,
      quantity: 1
    })),
    delivery_type: session.channel, // Define se é entrega ou retirada
    address: session.channel === "delivery" ? { street: session.address } : null,
    payment_method: "A combinar"
  };

  return await cardapioWebAPI("/orders", "POST", orderData);
}

// ===== WHATSAPP ENGINE (BOTÕES INTERATIVOS) =====

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

  // 1. BOAS VINDAS E ESCOLHA DE CANAL (ENTREGA OU RETIRADA)
  if (session.step === "start" || t === "oi" || t === "ola") {
    session.step = "ask_channel";
    await sendWhatsAppButtons(phone, "Olá! 🍕 Bem-vindo à Pappi Pizza. Como deseja seu pedido hoje?", ["Entrega 🛵", "Retirada 🥡"]);
    return;
  }

  // 2. CONFIGURAR CANAL E PEDIR ENDEREÇO SE NECESSÁRIO
  if (session.step === "ask_channel") {
    if (t.includes("entrega")) {
      session.channel = "delivery";
      session.step = "ask_address";
      await sendWhatsAppButtons(phone, "Ótimo! Para entrega, preciso do seu endereço completo (Rua, nº e bairro).", ["Digitar endereço"]);
    } else {
      session.channel = "takeaway"; // Equivalente a 'retirada' na API
      session.step = "ask_item";
      await sendWhatsAppButtons(phone, "Beleza! O que você vai pedir hoje? Digite o nome da pizza:", ["Ver Cardápio"]);
    }
    return;
  }

  // 3. CAPTURAR ENDEREÇO
  if (session.step === "ask_address") {
    session.address = text;
    session.step = "ask_item";
    await sendWhatsAppButtons(phone, "Endereço anotado! 📍 Agora, digite o nome da pizza que deseja:", ["Ver Cardápio"]);
    return;
  }

  // 4. BUSCAR ITEM NO CATÁLOGO E CONFIRMAR
  if (session.step === "ask_item") {
    const catalog = await cardapioWebAPI("/catalog");
    let found = null;

    catalog.categories?.forEach(cat => {
      cat.items?.forEach(item => {
        if (normalize(item.name).includes(t)) found = item;
      });
    });

    if (found) {
      session.tempProduct = { product_id: found.id, name: found.name };
      session.step = "confirm_item";
      await sendWhatsAppButtons(phone, `Encontrei: ${found.name}.\nConfirma este item no seu pedido?`, ["Confirmar ✅", "Escolher outro 🔄"]);
    } else {
      await sendWhatsAppButtons(phone, "Não encontrei esse item. Tente digitar o nome novamente conforme o cardápio:", ["Ver Cardápio"]);
    }
    return;
  }

  // 5. FINALIZAR PEDIDO NA API DO CARDÁPIO WEB
  if (session.step === "confirm_item") {
    if (t.includes("confirmar")) {
      session.cart.push(session.tempProduct);
      
      const resultado = await finalizarPedidoNoCardapioWeb(session, phone);
      
      if (resultado && resultado.id) {
        await sendWhatsAppButtons(phone, `✅ PEDIDO REALIZADO!\nNúmero: #${resultado.id}\nJá estamos preparando sua pizza!`, ["Novo Pedido", "Sair"]);
        session.step = "start";
        session.cart = [];
      } else {
        await sendWhatsAppButtons(phone, "❌ Erro ao enviar pedido. Chamei um atendente para te ajudar!", ["Falar com humano"]);
      }
    } else {
      session.step = "ask_item";
    }
    return;
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Bot Pappi Pizza rodando na porta ${PORT}`));
