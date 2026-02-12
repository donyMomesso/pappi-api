/**
 * Pappi Pizza API
 * WhatsApp Cloud + Cardápio Web + Atendimento Inteligente
 */

const express = require("express");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== ENV =====
const API_KEY = process.env.ATTENDANT_API_KEY || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "";
const CARDAPIOWEB_BASE_URL =
  process.env.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN || "";

// ===== SESSIONS =====
const SESSIONS = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function normalize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getSession(phone) {
  const now = Date.now();
  const s = SESSIONS.get(phone);
  if (s && now - s.lastSeen < SESSION_TTL_MS) {
    s.lastSeen = now;
    return s;
  }
  const fresh = {
    step: "start",
    channel: null,
    address: null,
    cart: [],
    lastSeen: now,
  };
  SESSIONS.set(phone, fresh);
  return fresh;
}

function looksLikeAddress(text) {
  const t = normalize(text);
  return (
    (t.includes("rua") || t.includes("av") || t.includes("avenida")) &&
    /\d{1,5}/.test(t)
  );
}

// ===== CARDAPIO WEB =====
async function cardapioWebFetch(path) {
  const url = `${CARDAPIOWEB_BASE_URL}${path}`;

  const resp = await fetch(url, {
    headers: {
      "X-API-KEY": CARDAPIOWEB_TOKEN,
      "Content-Type": "application/json",
    },
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error("Erro Cardápio Web");
  return data;
}

// 🔥 Busca catálogo completo
async function consultarCatalogo() {
  try {
    const data = await cardapioWebFetch("/catalog");
    return data;
  } catch {
    return null;
  }
}

// tenta encontrar produto pelo nome
function findProductInCatalog(catalog, text) {
  if (!catalog?.categories) return null;

  const t = normalize(text);

  for (const cat of catalog.categories) {
    for (const item of cat.items || []) {
      if (normalize(item.name).includes(t)) {
        return item;
      }
    }
  }
  return null;
}

// ===== WHATSAPP SEND =====
async function sendWhatsAppText(toNumber, text) {
  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: String(toNumber).replace(/\D/g, ""),
      type: "text",
      text: { body: text },
    }),
  });
}

// ===== EXTRAIR MSG =====
function extractIncomingMessages(body) {
  const out = [];
  const entry = body?.entry || [];
  for (const e of entry) {
    for (const c of e?.changes || []) {
      for (const m of c?.value?.messages || []) {
        out.push({
          from: m.from,
          text: m.text?.body || "",
        });
      }
    }
  }
  return out;
}

// ===== WEBHOOK VERIFY =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== WEBHOOK RECEBER MSG =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msgs = extractIncomingMessages(req.body);

  const catalog = await consultarCatalogo(); // 🔥 puxando direto do Cardápio Web

  for (const msg of msgs) {
    const text = msg.text;
    const t = normalize(text);
    const phone = msg.from;

    const session = getSession(phone);

    // ===== COMANDOS GERAIS =====
    if (t === "cardapio" || t === "menu") {
      session.step = "start";
      await sendWhatsAppText(
        phone,
        `📖 Cardápio Pappi Pizza:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony\n\nDigite retirada ou entrega.`
      );
      continue;
    }

    if (t.includes("promocao") || t.includes("promoção")) {
      await sendWhatsAppText(
        phone,
        `🔥 Promoções podem variar por dia.\nConfira aqui:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony`
      );
      continue;
    }

    // ===== FLUXO START =====
    if (session.step === "start") {
      if (t.includes("entrega")) {
        session.step = "ask_address";
        session.channel = "delivery";
        await sendWhatsAppText(
          phone,
          `Para entrega me mande:\nRua + número + bairro`
        );
        continue;
      }

      if (t.includes("retirada")) {
        session.step = "ask_item";
        session.channel = "takeout";
        await sendWhatsAppText(
          phone,
          `Beleza 👍\nMe diga o pedido.\nEx: pizza calabresa grande`
        );
        continue;
      }

      // tentar reconhecer item direto
      const product = findProductInCatalog(catalog, text);
      if (product) {
        session.pendingProduct = product.name;
        session.step = "ask_size";
        await sendWhatsAppText(
          phone,
          `Perfeito 😄 ${product.name}\nQual tamanho?\nBroto | Média | Grande`
        );
        continue;
      }

      await sendWhatsAppText(
        phone,
        `Olá! 👋 Sou a atendente automática da *Pappi Pizza* 🍕\n\nDigite:\n• cardápio\n• retirada\n• entrega`
      );
      continue;
    }

    // ===== ENDEREÇO =====
    if (session.step === "ask_address") {
      if (looksLikeAddress(text)) {
        session.address = text;
        session.step = "ask_item";

        await sendWhatsAppText(
          phone,
          `Endereço salvo ✅\nAgora me diga o pedido.\nEx: calabresa grande`
        );
      } else {
        await sendWhatsAppText(phone, `Me manda Rua + Número + Bairro 🙂`);
      }
      continue;
    }

    // ===== ESCOLHA TAMANHO =====
    if (session.step === "ask_size") {
      if (
        t === "broto" ||
        t === "media" ||
        t === "média" ||
        t === "grande"
      ) {
        session.size = t;
        session.step = "ask_channel";

        await sendWhatsAppText(phone, `Retirada ou entrega?`);
        continue;
      }

      await sendWhatsAppText(phone, `Escolha: broto, média ou grande.`);
      continue;
    }

    // ===== ESCOLHA CANAL =====
    if (session.step === "ask_channel") {
      if (t.includes("retirada")) {
        session.channel = "takeout";
        session.step = "confirm";
      } else if (t.includes("entrega")) {
        session.channel = "delivery";
        session.step = "ask_address";
        await sendWhatsAppText(phone, `Me mande o endereço.`);
        continue;
      }

      await sendWhatsAppText(
        phone,
        `Confirmar pedido:\n🍕 ${session.pendingProduct} ${session.size}\n\nDigite confirmar.`
      );
      continue;
    }

    // ===== CONFIRMAÇÃO =====
    if (session.step === "confirm") {
      if (t.includes("confirmar")) {
        session.step = "done";

        await sendWhatsAppText(
          phone,
          `Pedido confirmado ✅\nJá vamos preparar 😄`
        );
        continue;
      }

      await sendWhatsAppText(phone, `Digite confirmar para finalizar.`);
      continue;
    }
  }
});

// ===== HEALTH =====
app.get("/health", (req, res) => {
  res.json({ ok: true, app: "Pappi Pizza API" });
});

// ===== RUN =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🔥 Pappi Pizza API rodando na porta", PORT)
);

