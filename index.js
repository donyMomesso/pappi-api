/**
 * Pappi Pizza API - WhatsApp Cloud + Google Address Confirm + (Opcional) Cardápio Web Status/Webhook
 * Node 18+ (fetch nativo)
 *
 * ✅ Fluxo humanizado + carrinho (multi-pizza) + observação + upsell
 * ✅ Endereço do delivery só avança se confirmar no Google
 * ✅ "status 7637462" consulta Cardápio Web (se token ok)
 * ✅ Webhook Cardápio Web (opcional) para avisar automaticamente mudanças ao cliente
 */

const express = require("express");
const app = express();
app.use(express.json({ limit: "10mb" }));

// =====================
// ENV
// =====================
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "";

// Google (obrigatório p/ confirmar endereço)
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || "";

// Cardápio Web (opcional, mas recomendado para status)
const CARDAPIOWEB_BASE_URL =
  process.env.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com"; // produção
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN || "";

// Token opcional para validar webhook do Cardápio Web (vem no header X-Webhook-Token)
const CARDAPIOWEB_WEBHOOK_TOKEN = process.env.CARDAPIOWEB_WEBHOOK_TOKEN || "";

// Cardápio (imagem+link) fallback
const MENU_LINK = "https://app.cardapioweb.com/pappi_pizza?s=dony";
// Coloque uma imagem pública do cardápio (GitHub raw, CDN, etc)
const MENU_IMAGE_URL = process.env.MENU_IMAGE_URL || "";

// =====================
// Catálogo de Pizzas (sem preço) - extraído dos seus arquivos
// =====================
const PIZZAS = [
  { code: "001", name: "Mussarela", ingredients: "Mussarela, Tomate." },
  { code: "003", name: "Bauru", ingredients: "Presunto, Mussarela, Tomate." },
  { code: "004", name: "Milho", ingredients: "Mussarela, Milho." },
  { code: "005", name: "Milho com Catupiry", ingredients: "Mussarela, Milho, Catupiry." },
  { code: "006", name: "Portuguesa", ingredients: "Presunto, Mussarela, Ervilha, Ovo, Cebola." },
  { code: "007", name: "Frango Com Catupiry", ingredients: "Frango Desfiado, Mussarela, Catupiry." },
  { code: "008", name: "Frango Com Milho", ingredients: "Frango Desfiado, Mussarela, Milho." },
  { code: "009", name: "Frango Com Batata Palha", ingredients: "Frango Desfiado, Mussarela, Catupiry, Batata Palha." },
  { code: "010", name: "Moda da Casa", ingredients: "Frango Desfiado, Mussarela, Bacon, Catupiry, Tomate, Parmesão." },
  { code: "011", name: "Calabresa Com Mussarela", ingredients: "Calabresa, Mussarela, Cebola." },
  { code: "012", name: "Calabresa com Catupiry", ingredients: "Calabresa, Mussarela, Cebola, Catupiry." },
  { code: "013", name: "Portuguesa com Catupiry", ingredients: "Presunto, Mussarela, Ovo, Ervilha, Cebola, Catupiry." },
  { code: "014", name: "Catuperu", ingredients: "Mussarela, Peito de Peru Defumado, Catupiry." },
  { code: "015", name: "Baiana", ingredients: "Mussarela, Calabresa, Ovos, Pimenta, Cebola." },
  { code: "016", name: "Clássica", ingredients: "Mussarela, Peito de Peru Defumado, Champignon, Catupiry." },
  { code: "017", name: "Siciliana", ingredients: "Mussarela, Calabresa, Champignon, Bacon, Cebola." },
  { code: "018", name: "Palmito com catupiry", ingredients: "Mussarela, Palmito, Catupiry." },
  { code: "019", name: "Lombo com catupiry", ingredients: "Mussarela, Lombo Canadense, Catupiry." },
  { code: "020", name: "Brócolis", ingredients: "Mussarela, Brócolis, Cebola." },
  { code: "021", name: "Brócolis Especia", ingredients: "Mussarela, Brócolis, Catupiry, Bacon, Alho Frito." },
  { code: "022", name: "Bacon", ingredients: "Mussarela, Bacon." },
  { code: "023", name: "Bacon com Catupiry", ingredients: "Mussarela, Bacon, Catupiry." },
  { code: "024", name: "Quatro Queijos", ingredients: "Mussarela, Provolone, Gorgonzola, Catupiry." },
  { code: "025", name: "Do Pizzaolo", ingredients: "Mussarela, Presunto, Bacon, Milho, Batata Palha." },
  { code: "026", name: "Do Pappi", ingredients: "Mussarela, Calabresa, Champignon, Bacon, Provolone, Catupiry." },
  { code: "027", name: "Americana", ingredients: "Mussarela ,Presunto , Ovo , Bacon , Tomate." },
  { code: "028", name: "Czarina", ingredients: "Mussarela, Lombo, Ovo, Provolone, Tomate." },
  { code: "029", name: "Frango com Palmito", ingredients: "Mussarela, Frango Desfiado, Palmito." },
  { code: "030", name: "Frango ao Creme", ingredients: "Mussarela, Frango Desfiado, Creme de Milho, Catupiry, Batata Palha." },
  { code: "031", name: "Frangalho", ingredients: "Mussarela, Frango Desfiado, Alho Frito, Catupiry." },
  { code: "032", name: "Lombo ao Creme", ingredients: "Mussarela, Lombo, Creme de Milho." },
  { code: "033", name: "Portuguesa Especial", ingredients: "Mussarela, Presunto, Palmilto, Ervilha, Ovo, Cebola." },
  { code: "034", name: "Dois Queijos", ingredients: "Mussarela, Catupiry." },
  { code: "035", name: "Frango Com Cheddar", ingredients: "Mussarela, Frango Desfiado, Cheddar." },
  { code: "036", name: "Jardineira", ingredients: "Mussarela, Ervilha, Bacon, Palmito." },
  { code: "037", name: "Maromilho", ingredients: "Mussarela, Ovo, Milho, Bacon, Catupiry." },
  { code: "038", name: "Catuperu Especial", ingredients: "Mussarela, Peito de Peru, Tomate, Bacon, Catupiry." },
  { code: "039", name: "Toscana", ingredients: "Mussarela, Calabresa, Cebola, Tomate, Parmesão." },
  { code: "040", name: "Napolitana", ingredients: "Mussarela, Tomate, Parmesao." },
  { code: "041", name: "Guaçuana", ingredients: "Mussarela, Presunto, Bacon, Catupiry, Tomate, Parmesão." },
  { code: "042", name: "Italiana", ingredients: "Mussarela, Champignon, Catupiry." },
  { code: "043", name: "Peperone", ingredients: "Mussarela, Peperone." },
  { code: "044", name: "Atum com cebola", ingredients: "Mussarela, atum, cebola." },
  { code: "045", name: "Marguerita", ingredients: "Mussarela, Tomate, Parmesão, Manjericão." },
  { code: "047", name: "Vegetariana", ingredients: "Mussarela, Ervilha, Milho, Palmilto, Brocolis, Tomate." },
  { code: "048", name: "Carne seca", ingredients: "Mussarela, Carne Seca, Catupiry, Cebola, Tomate." },
  { code: "049", name: "Atum com Catupiry", ingredients: "Mussarela, Atum, Cebola, Catupiry." },
  { code: "050", name: "Peru com Philadelphia", ingredients: "Mussarela, Peito de Peru Def., Champingnon, Tomate, Philadelphia." },
  { code: "051", name: "Peperoni II", ingredients: "Mussarela, Peperoni, Philadelphia, tomate." }
];

// Bebidas placeholder (sem preço) — depois você me passa as oficiais
const DRINKS = [
  "Coca-Cola 2L",
  "Guaraná 2L",
  "Coca lata",
  "Guaraná lata",
  "Água"
];

// =====================
// Helpers texto
// =====================
function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function nowIso() {
  return new Date().toISOString();
}

function isNoObs(txt) {
  const t = normalizeText(txt);
  return (
    t === "sem obs" ||
    t === "sem observacao" ||
    t === "sem observação" ||
    t === "nao" ||
    t === "não" ||
    t === "padrão" ||
    t === "padrao" ||
    t === "normal"
  );
}

// match "status 7637462"
function parseStatusOrderId(text) {
  const t = normalizeText(text);
  const m = t.match(/\bstatus\s*(\d{4,})\b/);
  return m ? m[1] : null;
}

// =====================
// WhatsApp Cloud API
// =====================
async function waSend(payload) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurados.");
  }

  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || `Erro WhatsApp (${resp.status})`;
    const err = new Error(msg);
    err.payload = data;
    throw err;
  }
  return data;
}

async function sendText(to, text) {
  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "text",
    text: { body: text }
  });
}

async function sendButtons(to, bodyText, buttons /* [{id,title}] */) {
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
          reply: { id: b.id, title: b.title.slice(0, 20) }
        }))
      }
    }
  });
}

async function sendList(to, bodyText, buttonText, sections /* [{title, rows}] */) {
  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: buttonText.slice(0, 20),
        sections: sections.slice(0, 10).map((s) => ({
          title: (s.title || "Opções").slice(0, 24),
          rows: (s.rows || []).slice(0, 10).map((r) => ({
            id: String(r.id).slice(0, 200),
            title: String(r.title || "").slice(0, 24),
            description: r.description ? String(r.description).slice(0, 72) : undefined
          }))
        }))
      }
    }
  });
}

async function sendImage(to, imageUrl, caption) {
  if (!imageUrl) return;
  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "image",
    image: { link: imageUrl, caption: caption || "" }
  });
}

// =====================
// Google Geocode (obrigatório p/ delivery)
// =====================
async function googleGeocode(addressRaw) {
  if (!GOOGLE_MAPS_KEY) return [];

  // força Campinas-SP se não mencionar
  let q = addressRaw;
  if (!normalizeText(q).includes("campinas")) q = `${q}, Campinas - SP`;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    q
  )}&components=country:BR&key=${GOOGLE_MAPS_KEY}`;

  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));
  if (data.status !== "OK" || !Array.isArray(data.results) || data.results.length === 0) return [];

  return data.results.slice(0, 5).map((r) => ({
    formatted: r.formatted_address,
    location: r.geometry?.location || null,
    placeId: r.place_id || null
  }));
}

// =====================
// Cardápio Web (Status) - opcional
// =====================
async function cardapioWebFetch(path) {
  if (!CARDAPIOWEB_TOKEN) {
    const e = new Error("CARDAPIOWEB_TOKEN não configurado.");
    e.code = "NO_TOKEN";
    throw e;
  }

  const url = `${CARDAPIOWEB_BASE_URL}${path}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-API-KEY": CARDAPIOWEB_TOKEN
    }
  });

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    const err = new Error(data?.message || data?.error || "Erro Cardápio Web");
    err.status = resp.status;
    err.payload = data;
    throw err;
  }

  return data;
}

function humanizeOrderStatus(st) {
  const s = String(st || "").toLowerCase();
  const map = {
    waiting_confirmation: "Aguardando confirmação",
    pending_payment: "Pagamento pendente",
    pending_online_payment: "Aguardando confirmação do pagamento",
    scheduled_confirmed: "Agendado confirmado",
    confirmed: "Confirmado e em preparo",
    ready: "Pedido pronto ✅",
    released: "Saiu para entrega 🛵",
    waiting_to_catch: "Pronto aguardando retirada 🏃",
    delivered: "Entregue ✅",
    canceling: "Em processo de cancelamento",
    canceled: "Cancelado",
    closed: "Finalizado"
  };
  return map[s] || `Status atual: ${st}`;
}

// =====================
// Sessões (in-memory)
// =====================
const sessions = new Map();

function newSession() {
  return {
    step: "MENU",
    orderType: null, // delivery|takeout
    customerName: null,

    address: {
      raw: null,
      google: null,
      complement: null,
      reference: null
    },

    // carrinho multi-itens
    cart: [],

    // pizza em edição no momento
    draftPizza: null,

    payment: {
      method: null, // pix|debit|credit|money
      changeFor: null
    }
  };
}

function getSession(from) {
  if (!sessions.has(from)) sessions.set(from, newSession());
  return sessions.get(from);
}

function resetSession(from) {
  sessions.set(from, newSession());
  return sessions.get(from);
}

// =====================
// Menus humanizados
// =====================
async function showMainMenu(to) {
  await sendButtons(to, "🍕 Pappi Pizza\nOpa 😄 como posso te ajudar hoje?", [
    { id: "M_PEDIR", title: "🛒 Fazer pedido" },
    { id: "M_CARDAPIO", title: "📖 Cardápio" },
    { id: "M_STATUS", title: "📦 Status" }
  ]);
}

async function showAddMoreMenu(to) {
  await sendButtons(to, "Fechou ✅ Quer adicionar mais alguma coisa?", [
    { id: "ADD_PIZZA", title: "➕ Mais pizza" },
    { id: "ADD_BEBIDA", title: "🥤 Bebida" },
    { id: "FINALIZAR", title: "✅ Finalizar" }
  ]);
}

function summarizeCart(session) {
  if (!session.cart.length) return "—";

  const lines = session.cart.map((it, idx) => {
    if (it.type === "pizza") {
      const flav = it.flavors?.length ? it.flavors.join(" + ") : "—";
      const obs = it.observation ? `\n   Obs: ${it.observation}` : "";
      return `${idx + 1}) 🍕 ${it.sizeLabel} — ${flav}${obs}`;
    }
    if (it.type === "drink") {
      return `${idx + 1}) 🥤 ${it.name} — ${it.qty}x`;
    }
    return `${idx + 1}) ${it.type}`;
  });

  return lines.join("\n");
}

function orderSummaryText(session) {
  const tipo = session.orderType === "delivery" ? "Entrega" : "Retirada";
  const endereco =
    session.orderType === "delivery"
      ? `📍 ${session.address.google?.formatted || session.address.raw || "—"}\n` +
        `Complemento: ${session.address.complement || "—"}\n` +
        `Referência: ${session.address.reference || "—"}\n`
      : "";

  const cart = summarizeCart(session);

  const pay = session.payment.method
    ? `Pagamento: ${session.payment.method.toUpperCase()}${
        session.payment.method === "money"
          ? ` (troco: ${session.payment.changeFor || "sem troco"})`
          : ""
      }`
    : "Pagamento: —";

  return (
    `🧾 *Resumo do seu pedido*\n` +
    `Tipo: *${tipo}*\n` +
    (session.customerName ? `Nome: *${session.customerName}*\n` : "") +
    endereco +
    `\nItens:\n${cart}\n\n` +
    `${pay}\n\n` +
    `Tá tudo certinho? 😄`
  );
}

// =====================
// Catálogo: lista de sabores (paginado simples)
// =====================
function buildPizzaRows(offset = 0, limit = 10) {
  const slice = PIZZAS.slice(offset, offset + limit);
  return slice.map((p) => ({
    id: `PZ_${p.code}`,
    title: p.name,
    description: p.ingredients
  }));
}

async function sendPizzaList(to, offset = 0) {
  const rows = buildPizzaRows(offset, 10);

  const hasNext = offset + 10 < PIZZAS.length;
  if (hasNext) {
    rows.push({
      id: `PZ_MORE_${offset + 10}`,
      title: "➡️ Ver mais sabores",
      description: "Mostrar mais opções"
    });
  }

  await sendList(to, "Escolhe o sabor 😋 (ou digita o nome do sabor)", "Sabores", [
    { title: "Pizzas", rows }
  ]);
}

// tenta “adivinhar” sabor por texto digitado
function findBestPizzaMatches(userText) {
  const t = normalizeText(userText);
  if (!t) return [];

  // match direto por conter
  const direct = PIZZAS.filter((p) => normalizeText(p.name).includes(t));
  if (direct.length) return direct.slice(0, 5);

  // match por palavras
  const words = t.split(/\s+/).filter(Boolean);
  const scored = PIZZAS.map((p) => {
    const pn = normalizeText(p.name);
    let score = 0;
    for (const w of words) if (pn.includes(w)) score += 1;
    return { p, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 5).map((x) => x.p);
}

// =====================
// Webhook Meta - verificação
// =====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// =====================
// Webhook Cardápio Web (opcional) - notifica mudança de status
// URL sugerida no portal: https://pappi-api.onrender.com/cardapioweb/webhook
// =====================
app.post("/cardapioweb/webhook", async (req, res) => {
  // precisa responder 200 em até 5s
  res.status(200).send("ok");

  try {
    if (CARDAPIOWEB_WEBHOOK_TOKEN) {
      const headerToken = req.header("X-Webhook-Token") || "";
      if (headerToken !== CARDAPIOWEB_WEBHOOK_TOKEN) return;
    }

    const payload = req.body || {};
    // Como não temos o schema oficial do webhook aqui, tratamos de forma tolerante:
    const order = payload.order || payload.data?.order || payload.resource || payload;

    const orderId = order?.id || order?.order_id || null;
    const status = order?.status || order?.new_status || payload?.event?.status || null;
    const customerPhone = order?.customer?.phone || order?.customer_phone || null;
    const customerName = order?.customer?.name || null;

    if (!customerPhone || !status) return;

    const msg =
      `📦 Oi${customerName ? " " + customerName : ""}! Só passando pra te atualizar 😄\n` +
      `Pedido ${orderId ? "#" + orderId : ""}: *${humanizeOrderStatus(status)}*`;

    await sendText(customerPhone, msg);
  } catch (e) {
    console.error("CardapioWeb webhook error:", e?.message || e);
  }
});

// =====================
// Util: extrair mensagens do webhook Meta
// =====================
function extractIncomingMessages(body) {
  const out = [];
  const entry = body?.entry || [];
  for (const e of entry) {
    const changes = e?.changes || [];
    for (const c of changes) {
      const value = c?.value;
      const messages = value?.messages || [];
      for (const m of messages) {
        out.push({
          from: m.from,
          type: m.type,
          text: m.text?.body || "",
          interactive: m.interactive?.button_reply || m.interactive?.list_reply || null
        });
      }
    }
  }
  return out;
}

// =====================
// WEBHOOK META - mensagens
// =====================
app.post("/webhook", async (req, res) => {
  // WhatsApp exige resposta rápida
  res.sendStatus(200);

  try {
    const msgs = extractIncomingMessages(req.body);

    for (const msg of msgs) {
      const from = msg.from;
      const session = getSession(from);

      const text = (msg.text || "").trim();
      const normalized = normalizeText(text);

      const interactiveId = msg.interactive?.id || null;
      const interactiveTitle = msg.interactive?.title || null;

      // ---------------------------
      // Comandos universais
      // ---------------------------
      const wantsMenu =
        normalized === "menu" ||
        normalized === "inicio" ||
        normalized === "começar" ||
        normalized === "comecar" ||
        normalized === "oi" ||
        normalized === "ola" ||
        interactiveId === "BACK_MENU";

      if (wantsMenu) {
        resetSession(from);
        await showMainMenu(from);
        continue;
      }

      // ---------------------------
      // STATUS (texto livre)
      // ---------------------------
      const orderIdStatus = parseStatusOrderId(text);
      const wantsStatus =
        Boolean(orderIdStatus) ||
        normalized.includes("status") ||
        normalized.includes("meu pedido") ||
        normalized.includes("cadê") ||
        normalized.includes("cade") ||
        normalized.includes("atras") ||
        normalized.includes("demor");

      // se ele está no menu e pede status
      if (interactiveId === "M_STATUS") {
        session.step = "STATUS";
        await sendText(from, "Me manda o número do pedido assim:\n*status 7637462*");
        continue;
      }

      if (wantsStatus && session.step !== "ASK_ADDRESS_CONFIRM") {
        const id = orderIdStatus;

        if (!id) {
          session.step = "STATUS";
          await sendText(from, "Entendi 😄\nMe manda o número do pedido assim:\n*status 7637462*");
          continue;
        }

        await sendText(from, "🔎 Um segundinho… tô consultando no sistema agora.");

        try {
          const order = await cardapioWebFetch(`/api/partner/v1/orders/${id}`);
          const statusText = humanizeOrderStatus(order?.status);

          // mensagem humanizada + “acalmar” se for atraso
          let extra = "";
          if (String(order?.status || "").toLowerCase() === "confirmed") {
            extra = "\n\n🙏 Tá em preparo. Se passar do prazo, eu te atualizo por aqui.";
          }

          await sendText(from, `📦 Pedido #${id}\n*${statusText}*${extra}`);
        } catch (e) {
          // Exemplo real seu: {"code":4010,"message":"Token inválido."}
          const msgErr =
            e?.payload?.message ||
            e?.payload?.error ||
            e?.message ||
            "Não consegui consultar agora.";

          if (String(msgErr).toLowerCase().includes("token")) {
            await sendText(
              from,
              "Tô sem acesso ao status no sistema agora 😕 (token inválido)\nMas se você me disser se é *entrega* ou *retirada* e o *bairro*, eu te atualizo manualmente rapidinho."
            );
          } else {
            await sendText(
              from,
              "Não consegui localizar esse pedido 😕\nConfere o número e manda de novo.\nEx: *status 7637462*"
            );
          }
        }

        continue;
      }

      // ---------------------------
      // MENU principal
      // ---------------------------
      if (interactiveId === "M_CARDAPIO") {
        if (MENU_IMAGE_URL) {
          await sendImage(from, MENU_IMAGE_URL, "📖 Cardápio (imagem)");
        }
        await sendText(
          from,
          `📖 Cardápio online:\n${MENU_LINK}\n\nSe quiser, me diga: *tamanho + sabores* que eu já monto o pedido pra você 😄`
        );
        await showMainMenu(from);
        continue;
      }

      if (interactiveId === "M_PEDIR") {
        session.step = "ORDER_TYPE";
        await sendButtons(from, "Show! Vai ser *entrega* ou *retirada*?", [
          { id: "TYPE_DELIVERY", title: "🛵 Entrega" },
          { id: "TYPE_TAKEOUT", title: "🏃 Retirada" },
          { id: "BACK_MENU", title: "⬅️ Menu" }
        ]);
        continue;
      }

      // ---------------------------
      // Tipo de pedido
      // ---------------------------
      if (interactiveId === "TYPE_DELIVERY") {
        session.orderType = "delivery";
        session.step = "ASK_ADDRESS_RAW";

        if (!GOOGLE_MAPS_KEY) {
          await sendText(
            from,
            "⚠️ Só um detalhe: preciso do Google configurado pra confirmar endereço.\nPeça pro suporte configurar o *GOOGLE_MAPS_KEY* no Render.\n\nEnquanto isso, me manda: *Rua + número + bairro*."
          );
        } else {
          await sendText(
            from,
            "📍 Me manda seu endereço assim: *Rua + número + bairro* (Campinas)\nEx: Rua X, 123 - Jardim das Bandeiras"
          );
        }
        continue;
      }

      if (interactiveId === "TYPE_TAKEOUT") {
        session.orderType = "takeout";
        session.step = "ASK_NAME";
        await sendText(from, "🏃 Retirada beleza! Qual seu *nome* pra eu colocar no pedido?");
        continue;
      }

      // ---------------------------
      // Nome (retirada)
      // ---------------------------
      if (session.step === "ASK_NAME" && !interactiveId) {
        if ((text || "").length < 2) {
          await sendText(from, "Me diz só seu nome rapidinho 😄");
          continue;
        }
        session.customerName = text.trim();
        session.step = "ADD_ITEM_MENU";
        await sendButtons(from, `Fechou, ${session.customerName}! 😄\nO que você quer pedir?`, [
          { id: "ITEM_PIZZA", title: "🍕 Pizza" },
          { id: "ITEM_BEBIDA", title: "🥤 Bebida" },
          { id: "FINALIZAR", title: "✅ Finalizar" }
        ]);
        continue;
      }

      // ---------------------------
      // Endereço (delivery) - precisa confirmar no Google
      // ---------------------------
      if (session.step === "ASK_ADDRESS_RAW" && !interactiveId) {
        if ((text || "").length < 8) {
          await sendText(from, "Esse endereço ficou curtinho 😅\nMe manda *Rua + número + bairro*.");
          continue;
        }

        session.address.raw = text.trim();

        if (!GOOGLE_MAPS_KEY) {
          // sem Google, volta pedindo confirmação manual
          session.step = "ASK_ADDRESS_COMPLEMENT";
          await sendText(from, "Beleza! Agora:\n1) Complemento (apto/bloco/casa/fundos) ou *SEM*\n2) Referência (opcional)");
          continue;
        }

        await sendText(from, "🔎 Só um segundinho… vou confirmar no Google 😄");

        const results = await googleGeocode(session.address.raw);

        if (!results.length) {
          await sendText(
            from,
            "Não consegui localizar no Google 😕\nTenta assim: *Rua + número - bairro*.\nEx: Rua X, 123 - Jardim das Bandeiras"
          );
          continue;
        }

        // 1 resultado: pede confirmação
        if (results.length === 1) {
          session.address.google = results[0];
          session.step = "ASK_ADDRESS_CONFIRM";
          const mapsLink = results[0].placeId
            ? `https://www.google.com/maps/place/?q=place_id:${results[0].placeId}`
            : "";

          await sendButtons(
            from,
            `🔎 Achei esse endereço:\n*${results[0].formatted}*\n\nConfirma?${mapsLink ? `\n${mapsLink}` : ""}`,
            [
              { id: "ADDR_YES", title: "✅ Confirmar" },
              { id: "ADDR_NO", title: "❌ Corrigir" },
              { id: "ADDR_OPTIONS", title: "📍 Opções" }
            ]
          );
          continue;
        }

        // vários: lista opções
        session.address.candidates = results;
        session.step = "ASK_ADDRESS_PICK";

        const rows = results.map((r, i) => ({
          id: `ADDR_PICK_${i}`,
          title: (r.formatted.split(",")[0] || "Opção").slice(0, 23),
          description: r.formatted.slice(0, 70)
        }));

        await sendList(from, "Qual endereço é o correto?", "Endereços", [{ title: "Opções", rows }]);
        continue;
      }

      if (interactiveId === "ADDR_OPTIONS" && session.address.google) {
        // mostra opções novamente se tiver candidatos (ou tenta refazer)
        const results = await googleGeocode(session.address.raw || "");
        session.address.candidates = results;

        const rows = results.map((r, i) => ({
          id: `ADDR_PICK_${i}`,
          title: (r.formatted.split(",")[0] || "Opção").slice(0, 23),
          description: r.formatted.slice(0, 70)
        }));
        await sendList(from, "Beleza 🙂 escolhe o correto:", "Endereços", [{ title: "Opções", rows }]);
        continue;
      }

      if (interactiveId === "ADDR_NO") {
        session.step = "ASK_ADDRESS_RAW";
        session.address.google = null;
        await sendText(from, "Tranquilo 😄\nMe manda o endereço de novo: *Rua + número + bairro*.");
        continue;
      }

      if (interactiveId && interactiveId.startsWith("ADDR_PICK_")) {
        const idx = Number(String(interactiveId).replace("ADDR_PICK_", ""));
        const chosen = session.address.candidates?.[idx];
        if (!chosen) {
          session.step = "ASK_ADDRESS_RAW";
          await sendText(from, "Ops, não peguei essa opção 😅\nMe manda o endereço de novo.");
          continue;
        }

        session.address.google = chosen;
        session.step = "ASK_ADDRESS_CONFIRM";

        const mapsLink = chosen.placeId
          ? `https://www.google.com/maps/place/?q=place_id:${chosen.placeId}`
          : "";

        await sendButtons(
          from,
          `🔎 Achei esse endereço:\n*${chosen.formatted}*\n\nConfirma?${mapsLink ? `\n${mapsLink}` : ""}`,
          [
            { id: "ADDR_YES", title: "✅ Confirmar" },
            { id: "ADDR_NO", title: "❌ Corrigir" },
            { id: "BACK_MENU", title: "⬅️ Menu" }
          ]
        );
        continue;
      }

      if (interactiveId === "ADDR_YES" && session.step === "ASK_ADDRESS_CONFIRM") {
        session.step = "ASK_ADDRESS_COMPLEMENT";
        await sendText(
          from,
          "Perfeito 😄 Agora só pra eu não errar:\n1) Complemento (apto/bloco/casa/fundos) ou *SEM*\n2) Ponto de referência (opcional)"
        );
        continue;
      }

      if (session.step === "ASK_ADDRESS_COMPLEMENT" && !interactiveId) {
        const t = normalizeText(text);

        // dica simples: se vier 2 linhas, separa; senão, considera complemento
        const parts = (text || "").split("\n").map((x) => x.trim()).filter(Boolean);
        if (parts.length >= 2) {
          session.address.complement = isNoObs(parts[0]) ? "" : parts[0];
          session.address.reference = isNoObs(parts[1]) ? "" : parts[1];
        } else {
          // tenta separar por "ref:" ou "-"
          const m = (text || "").match(/(.*?)(?:ref[:\-]\s*)(.*)/i);
          if (m) {
            session.address.complement = isNoObs(m[1]) ? "" : m[1].trim();
            session.address.reference = isNoObs(m[2]) ? "" : m[2].trim();
          } else {
            session.address.complement = isNoObs(t) ? "" : text.trim();
            session.address.reference = "";
          }
        }

        session.step = "ADD_ITEM_MENU";
        await sendButtons(from, "Fechou ✅ O que você quer pedir agora?", [
          { id: "ITEM_PIZZA", title: "🍕 Pizza" },
          { id: "ITEM_BEBIDA", title: "🥤 Bebida" },
          { id: "FINALIZAR", title: "✅ Finalizar" }
        ]);
        continue;
      }

      // ---------------------------
      // Adicionar itens
      // ---------------------------
      if (interactiveId === "ITEM_PIZZA" || interactiveId === "ADD_PIZZA") {
        session.step = "PIZZA_SIZE";
        session.draftPizza = {
          type: "pizza",
          sizeKey: null,
          sizeLabel: null,
          maxFlavors: null,
          qty: 1,
          flavors: [],
          observation: ""
        };

        await sendButtons(from, "🍕 Qual tamanho?", [
          { id: "SZ_BROT", title: "Brotinho" },
          { id: "SZ_8", title: "8 fatias" },
          { id: "SZ_16", title: "16 fatias" }
        ]);
        continue;
      }

      if (interactiveId === "ITEM_BEBIDA" || interactiveId === "ADD_BEBIDA") {
        session.step = "DRINK_PICK";
        const rows = DRINKS.slice(0, 9).map((d, i) => ({
          id: `DR_${i}`,
          title: d,
          description: "Adicionar ao pedido"
        }));
        await sendList(from, "Qual bebida você quer colocar?", "Bebidas", [{ title: "Opções", rows }]);
        continue;
      }

      // ---------------------------
      // Bebidas
      // ---------------------------
      if (interactiveId && interactiveId.startsWith("DR_")) {
        const idx = Number(String(interactiveId).replace("DR_", ""));
        const drink = DRINKS[idx];
        if (!drink) {
          await sendText(from, "Não peguei essa bebida 😅\nEscolhe de novo pra mim.");
          session.step = "DRINK_PICK";
          continue;
        }

        session.draftDrink = { type: "drink", name: drink, qty: 1 };
        session.step = "DRINK_QTY";
        await sendText(from, `Boa 😄 Quantas *${drink}* você quer? (ex: 1, 2, 3)`);
        continue;
      }

      if (session.step === "DRINK_QTY" && !interactiveId) {
        const n = Number((text || "").trim());
        if (!Number.isFinite(n) || n <= 0 || n > 20) {
          await sendText(from, "Me manda só a quantidade em número 😄 (ex: 1, 2, 3)");
          continue;
        }
        session.draftDrink.qty = n;
        session.cart.push(session.draftDrink);
        session.draftDrink = null;

        // Upsell suave (se não tem bebida ainda, sugere)
        await sendText(from, "Fechou ✅ bebida adicionada!");
        await showAddMoreMenu(from);
        session.step = "ADD_MORE";
        continue;
      }

      // ---------------------------
      // Pizza: tamanho
      // ---------------------------
      if (interactiveId && ["SZ_BROT", "SZ_8", "SZ_16"].includes(interactiveId)) {
        const draft = session.draftPizza;
        if (!draft) continue;

        if (interactiveId === "SZ_BROT") {
          draft.sizeKey = "BROTINHO";
          draft.sizeLabel = "Brotinho";
          draft.maxFlavors = 1;
        }
        if (interactiveId === "SZ_8") {
          draft.sizeKey = "OITO";
          draft.sizeLabel = "8 fatias";
          draft.maxFlavors = 2;
        }
        if (interactiveId === "SZ_16") {
          draft.sizeKey = "DEZESSEIS";
          draft.sizeLabel = "16 fatias";
          draft.maxFlavors = 4;
        }

        session.step = "PIZZA_QTY";
        await sendText(from, `Show 😄 Quantas pizzas de *${draft.sizeLabel}* você quer? (ex: 1, 2, 3)`);
        continue;
      }

      // Pizza: quantidade
      if (session.step === "PIZZA_QTY" && !interactiveId) {
        const draft = session.draftPizza;
        if (!draft) continue;

        const n = Number((text || "").trim());
        if (!Number.isFinite(n) || n <= 0 || n > 20) {
          await sendText(from, "Me manda só a quantidade em número 😄 (ex: 1, 2, 3)");
          continue;
        }
        draft.qty = n;

        session.step = "PIZZA_FLAVORS";
        // manda lista + instrução
        await sendText(
          from,
          `Perfeito 😋 Agora os sabores:\n• ${draft.sizeLabel} permite *até ${draft.maxFlavors} sabor(es)*.\n\nVocê pode *digitar* (ex: Calabresa + Mussarela)\nOU escolher na lista abaixo.`
        );
        await sendPizzaList(from, 0);
        continue;
      }

      // Pizza: lista paginada
      if (interactiveId && interactiveId.startsWith("PZ_MORE_")) {
        const off = Number(String(interactiveId).replace("PZ_MORE_", ""));
        await sendPizzaList(from, Number.isFinite(off) ? off : 0);
        continue;
      }

      // Pizza: seleção via lista
      if (interactiveId && interactiveId.startsWith("PZ_") && session.step === "PIZZA_FLAVORS") {
        const code = String(interactiveId).replace("PZ_", "");
        const pizza = PIZZAS.find((p) => p.code === code);
        if (!pizza) continue;

        const draft = session.draftPizza;
        if (!draft) continue;

        if (draft.flavors.length >= draft.maxFlavors) {
          await sendText(from, `Pra ${draft.sizeLabel} é até *${draft.maxFlavors}* sabor(es). Quer trocar algum?`);
          continue;
        }

        draft.flavors.push(pizza.name);

        if (draft.flavors.length >= draft.maxFlavors) {
          session.step = "PIZZA_OBS";
          await sendText(
            from,
            "Top 😄\nQuer alguma observação nessa pizza?\nEx: sem cebola / bem assada / cortar quadrado\n\nSe não tiver, responde: *SEM OBS*"
          );
        } else {
          await sendText(from, `Boa! Já peguei: *${draft.flavors.join(" + ")}*.\nQuer escolher mais um sabor?`);
        }
        continue;
      }

      // Pizza: sabores digitados
      if (session.step === "PIZZA_FLAVORS" && !interactiveId) {
        const draft = session.draftPizza;
        if (!draft) continue;

        // divide por +, /, e, metade
        const parts = text
          .split(/\+|\/|,| e /i)
          .map((x) => x.trim())
          .filter(Boolean);

        if (!parts.length) {
          await sendText(from, "Me manda pelo menos 1 sabor 😄");
          continue;
        }

        if (parts.length > draft.maxFlavors) {
          await sendText(
            from,
            `Pra ${draft.sizeLabel} é até *${draft.maxFlavors}* sabor(es).\nMe diz quais ${draft.maxFlavors} você quer.`
          );
          continue;
        }

        // tenta validar por aproximação
        const finalFlavors = [];
        for (const p of parts) {
          const match = findBestPizzaMatches(p);
          if (match.length === 1) {
            finalFlavors.push(match[0].name);
          } else if (match.length > 1) {
            // sugere e pede confirmar
            session.step = "PIZZA_FLAVOR_DISAMBIG";
            session.draftDisambig = { original: p, options: match.slice(0, 5) };

            const rows = match.slice(0, 5).map((opt) => ({
              id: `PZ_${opt.code}`,
              title: opt.name,
              description: opt.ingredients
            }));

            await sendList(
              from,
              `Quando você disse "*${p}*", qual dessas você quis dizer?`,
              "Opções",
              [{ title: "Sugestões", rows }]
            );
            return;
          } else {
            // nenhum match: pede escolher na lista
            await sendText(
              from,
              `Não encontrei esse sabor: *${p}* 😅\nEscolhe na lista pra eu não errar.`
            );
            await sendPizzaList(from, 0);
            return;
          }
        }

        draft.flavors = finalFlavors;

        session.step = "PIZZA_OBS";
        await sendText(
          from,
          "Top 😄\nQuer alguma observação nessa pizza?\nEx: sem cebola / bem assada / cortar quadrado\n\nSe não tiver, responde: *SEM OBS*"
        );
        continue;
      }

      // Pizza: observação
      if (session.step === "PIZZA_OBS" && !interactiveId) {
        const draft = session.draftPizza;
        if (!draft) continue;

        draft.observation = isNoObs(text) ? "" : text.trim();

        // adiciona no carrinho respeitando qty
        for (let i = 0; i < (draft.qty || 1); i++) {
          session.cart.push({
            type: "pizza",
            sizeKey: draft.sizeKey,
            sizeLabel: draft.sizeLabel,
            flavors: [...draft.flavors],
            observation: draft.observation
          });
        }

        session.draftPizza = null;

        // Upsell humanizado (se ainda não tem bebida no carrinho)
        const hasDrink = session.cart.some((x) => x.type === "drink");
        if (!hasDrink) {
          await sendButtons(
            from,
            "Boa 😋\nPra acompanhar, quer colocar uma bebida?",
            [
              { id: "ADD_BEBIDA", title: "🥤 Sim" },
              { id: "NO_UPSELL", title: "Agora não" },
              { id: "FINALIZAR", title: "✅ Finalizar" }
            ]
          );
          session.step = "ADD_MORE";
          continue;
        }

        await showAddMoreMenu(from);
        session.step = "ADD_MORE";
        continue;
      }

      if (interactiveId === "NO_UPSELL") {
        await showAddMoreMenu(from);
        session.step = "ADD_MORE";
        continue;
      }

      // ---------------------------
      // Finalizar / pagamento / revisão
      // ---------------------------
      if (interactiveId === "FINALIZAR") {
        if (!session.cart.length) {
          await sendText(from, "Você ainda não colocou nada no pedido 😄\nQuer pedir uma pizza?");
          await showMainMenu(from);
          session.step = "MENU";
          continue;
        }

        session.step = "PAYMENT";
        await sendButtons(from, "💳 E pra pagar, como você prefere?", [
          { id: "PAY_PIX", title: "Pix" },
          { id: "PAY_DEB", title: "Débito" },
          { id: "PAY_CRE", title: "Crédito" }
        ]);
        continue;
      }

      if (interactiveId && ["PAY_PIX", "PAY_DEB", "PAY_CRE", "PAY_MONEY"].includes(interactiveId)) {
        if (interactiveId === "PAY_PIX") session.payment.method = "pix";
        if (interactiveId === "PAY_DEB") session.payment.method = "debito";
        if (interactiveId === "PAY_CRE") session.payment.method = "credito";
        if (interactiveId === "PAY_MONEY") session.payment.method = "money";

        // dinheiro → pedir troco
        if (session.payment.method === "money") {
          session.step = "PAY_CHANGE";
          await sendText(from, "Beleza 😄 Troco pra quanto? (se não precisar, responde: *SEM TROCO*)");
          continue;
        }

        // vai para revisão
        session.step = "REVIEW";
        await sendButtons(from, orderSummaryText(session), [
          { id: "CONFIRM_OK", title: "✅ Confirmar" },
          { id: "ADD_MORE", title: "➕ Adicionar" },
          { id: "BACK_MENU", title: "❌ Cancelar" }
        ]);
        continue;
      }

      if (session.step === "PAY_CHANGE" && !interactiveId) {
        const t = normalizeText(text);
        session.payment.changeFor = t.includes("sem") ? "" : text.trim();

        session.step = "REVIEW";
        await sendButtons(from, orderSummaryText(session), [
          { id: "CONFIRM_OK", title: "✅ Confirmar" },
          { id: "ADD_MORE", title: "➕ Adicionar" },
          { id: "BACK_MENU", title: "❌ Cancelar" }
        ]);
        continue;
      }

      if (interactiveId === "ADD_MORE") {
        await showAddMoreMenu(from);
        session.step = "ADD_MORE";
        continue;
      }

      if (interactiveId === "CONFIRM_OK") {
        // Aqui você pode integrar criação de pedido real; por enquanto, envia pro WhatsApp humano
        const summary = orderSummaryText(session)
          .replace(/\*/g, "")
          .replace("Tá tudo certinho? 😄", "");

        const phoneToFinish = "5519982275105"; // seu número de finalização
        const url = `https://wa.me/${phoneToFinish}?text=${encodeURIComponent(summary)}`;

        await sendText(from, `✅ Fechado! Já enviei seu pedido pra confirmação 😄\n\nFinalize por aqui:\n${url}`);
        resetSession(from);
        continue;
      }

      // ---------------------------
      // Fallback humanizado (conversa solta)
      // ---------------------------
      // Se chegou aqui, responde como gente e puxa de volta pro fluxo
      if (text) {
        // respostas rápidas pra perguntas comuns
        if (normalized.includes("tempo") || normalized.includes("demora")) {
          await sendText(
            from,
            "Boa 😄\nMe confirma se é *entrega ou retirada* e qual o *bairro*, que eu te passo uma previsão bem certinha."
          );
          await showMainMenu(from);
          continue;
        }

        if (normalized.includes("melhor") || normalized.includes("indica") || normalized.includes("recomenda")) {
          await sendText(
            from,
            "Se você curte sabor marcante: *Calabresa com Catupiry* ou *Portuguesa com Catupiry* 😋\nQuer pizza de 8 fatias?"
          );
          await showMainMenu(from);
          continue;
        }

        // padrão
        await sendText(from, "Entendi 😄 Pra ficar bem rápido, escolhe uma opção aqui embaixo:");
        await showMainMenu(from);
      }
    }
  } catch (e) {
    console.error("Webhook error:", e?.message, e?.payload || e);
  }
});

// =====================
// Health/Debug
// =====================
app.get("/", (req, res) => res.status(200).send("Pappi API online ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true, time: nowIso() }));

app.get("/debug-auth", (req, res) => {
  res.status(200).json({
    ok: true,
    hasWhatsappToken: Boolean(WHATSAPP_TOKEN),
    hasWhatsappPhoneNumberId: Boolean(WHATSAPP_PHONE_NUMBER_ID),
    hasWebhookVerifyToken: Boolean(WEBHOOK_VERIFY_TOKEN),
    hasGoogleMapsKey: Boolean(GOOGLE_MAPS_KEY),
    cardapioWebBaseUrl: CARDAPIOWEB_BASE_URL,
    hasCardapioWebToken: Boolean(CARDAPIOWEB_TOKEN),
    hasMenuImageUrl: Boolean(MENU_IMAGE_URL)
  });
});

// =====================
// Run
// =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));


