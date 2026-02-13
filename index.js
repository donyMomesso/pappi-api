/**
 * Pappi Pizza API - WhatsApp Cloud + Cardápio Web + Google Maps + Webhook Cardápio Web
 * Node 18+ (fetch nativo)
 *
 * Rotas:
 * - GET  /health
 * - GET  /webhook              (verify Meta)
 * - POST /webhook              (WhatsApp messages)
 * - POST /cardapioweb/webhook  (Cardápio Web events -> notifica cliente)
 */

const express = require("express");
const app = express();
app.use(express.json({ limit: "10mb" }));

// ===== ENV / CONFIG =====
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "";

const CARDAPIOWEB_BASE_URL =
  process.env.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN || "";

const CARDAPIOWEB_WEBHOOK_TOKEN = process.env.CARDAPIOWEB_WEBHOOK_TOKEN || "";

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || "";

const STORE_LOCATION = {
  lat: Number(process.env.STORE_LAT || -22.90556),
  lng: Number(process.env.STORE_LNG || -47.06083),
};

const MAX_DELIVERY_RADIUS_KM = Number(process.env.MAX_DELIVERY_RADIUS_KM || 12);

// Número do atendimento (para finalizar pedido no humano)
const ATTENDANT_WA_PHONE = digitsOnly(process.env.ATTENDANT_WA_PHONE || "5519982275105");

// ===== FALLBACK CATALOG (backup se API falhar) =====
const FALLBACK_CATALOG = {
  categories: [
    {
      id: "cat_pizzas",
      name: "🍕 Pizzas Salgadas",
      items: [
        { id: "2991", name: "Calabresa", description: "Clássica com cebola e azeitonas", price: 30.0 },
        { id: "2992", name: "Frango c/ Catupiry", description: "Frango desfiado e catupiry original", price: 35.0 },
        { id: "2988", name: "Margherita", description: "Molho, mussarela, tomate e manjericão", price: 32.0 },
        { id: "2995", name: "Portuguesa", description: "Presunto, ovos, cebola e ervilha", price: 34.0 },
        { id: "3010", name: "À Moda da Casa", description: "Especialidade do Pappi", price: 40.0 },
      ],
    },
    {
      id: "cat_bebidas",
      name: "🥤 Bebidas",
      items: [
        { id: "3006", name: "Coca-Cola 2L", description: "Garrafa 2 Litros", price: 14.0 },
        { id: "3005", name: "Guaraná 2L", description: "Garrafa 2 Litros", price: 12.0 },
        { id: "3007", name: "Heineken Long Neck", description: "Cerveja 330ml", price: 10.0 },
      ],
    },
  ],
};

// ===== HELPERS =====
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

function extractOrderIdFromText(text) {
  const m = String(text || "").match(/\b\d{4,}\b/); // 4+ dígitos
  return m ? m[0] : null;
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ===== Cardápio Web API =====
async function cardapioWebFetch(path, { method = "GET", body } = {}) {
  if (!CARDAPIOWEB_TOKEN) throw new Error("CARDAPIOWEB_TOKEN não configurado.");
  const url = `${CARDAPIOWEB_BASE_URL}${path}`;

  const resp = await fetch(url, {
    method,
    headers: {
      "X-API-KEY": CARDAPIOWEB_TOKEN,
      Accept: "application/json",
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    const err = new Error(data?.message || data?.error || text || `Erro Cardápio Web (${resp.status})`);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function getCatalog() {
  // fallback se token ausente
  if (!CARDAPIOWEB_TOKEN) return FALLBACK_CATALOG;

  try {
    const data = await cardapioWebFetch(`/api/partner/v1/catalog`);
    if (!data?.categories?.length) throw new Error("Catálogo vazio");
    return data;
  } catch (e) {
    console.error("❌ Erro Cardápio Web /catalog (fallback):", e.message);
    return FALLBACK_CATALOG;
  }
}

async function getOrderById(orderId) {
  const id = String(orderId || "").trim();
  return cardapioWebFetch(`/api/partner/v1/orders/${encodeURIComponent(id)}`);
}

// ===== Google Maps =====
async function googleGeocode(address) {
  if (!GOOGLE_MAPS_KEY) return [];

  let query = String(address || "").trim();
  if (!query) return [];

  if (!normalizeText(query).includes("campinas")) query = `${query}, Campinas - SP`;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    query
  )}&components=country:BR&key=${GOOGLE_MAPS_KEY}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status === "OK" && data.results?.length) {
      return data.results.slice(0, 6).map((r) => ({
        formatted: r.formatted_address,
        location: r.geometry.location,
        placeId: r.place_id,
      }));
    }
  } catch (e) {
    console.error("Erro Google Geocode:", e?.message || e);
  }
  return [];
}

function staticMapUrl(lat, lng) {
  if (!GOOGLE_MAPS_KEY) return null;
  return `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=600x300&maptype=roadmap&markers=color:red%7C${lat},${lng}&key=${GOOGLE_MAPS_KEY}`;
}

// ===== WhatsApp Cloud Send =====
async function waSend(to, payload) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID não configurados.");
  }
  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to: digitsOnly(to), ...payload }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data?.error?.message || `Erro WhatsApp (${resp.status})`);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function sendText(to, text) {
  return waSend(to, { type: "text", text: { body: text } });
}

async function sendButtons(to, text, buttons) {
  return waSend(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: String(b.title || "").slice(0, 20) },
        })),
      },
    },
  });
}

async function sendList(to, text, buttonText, sections) {
  return waSend(to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text },
      action: {
        button: String(buttonText || "").slice(0, 20),
        sections: (sections || []).slice(0, 10).map((s) => ({
          title: String(s.title || "Opções").slice(0, 24),
          rows: (s.rows || []).slice(0, 10).map((r) => ({
            id: String(r.id).slice(0, 200),
            title: String(r.title || "").slice(0, 24),
            description: r.description ? String(r.description).slice(0, 72) : undefined,
          })),
        })),
      },
    },
  });
}

async function sendLocationImage(to, lat, lng, caption) {
  const link = staticMapUrl(lat, lng);
  if (!link) {
    // sem key, só texto
    return sendText(to, caption);
  }
  return waSend(to, { type: "image", image: { link, caption } });
}

// ===== Status formatter =====
function formatOrderStatus(order) {
  const status = order?.status || "desconhecido";
  const display = order?.display_id ? `#${order.display_id}` : "";
  const id = order?.id ? `(${order.id})` : "";

  const tipo =
    order?.order_type === "delivery"
      ? "Entrega"
      : order?.order_type === "takeout"
      ? "Retirada"
      : order?.order_type || "Pedido";

  const base = `📦 *Status do pedido* ${display} ${id}\nTipo: *${tipo}*`;

  switch (status) {
    case "waiting_confirmation":
      return `${base}\n🕒 *Aguardando confirmação*`;
    case "pending_payment":
      return `${base}\n💳 *Pagamento pendente*`;
    case "pending_online_payment":
      return `${base}\n💳 *Aguardando pagamento online*`;
    case "scheduled_confirmed":
      return `${base}\n🗓️ *Agendado confirmado*`;
    case "confirmed":
      return `${base}\n👨‍🍳 *Confirmado e em preparo*`;
    case "ready":
      return order?.order_type === "delivery"
        ? `${base}\n🔥 *Pronto!* Em instantes sai para entrega 🚗`
        : `${base}\n🔥 *Pronto!* Já pode retirar 🏃`;
    case "released":
      return `${base}\n🚗 *Saiu para entrega*`;
    case "waiting_to_catch":
      return `${base}\n🏃 *Pronto e aguardando retirada*`;
    case "delivered":
      return `${base}\n✅ *Entregue*`;
    case "canceled":
      return `${base}\n❌ *Cancelado*`;
    case "closed":
      return `${base}\n✅ *Finalizado*`;
    default:
      return `${base}\n📌 Status: *${status}*`;
  }
}

// ===== SESSIONS =====
/**
 * session = {
 *  step,
 *  orderType,
 *  addressQuery,
 *  candidateAddresses: [],
 *  addressData,
 *  selectedCategoryId,
 *  selectedCategoryName,
 *  selectedItemId,
 *  selectedItemName,
 *  selectedSize,
 *  lastOrderId
 * }
 */
const sessions = new Map();
function getSession(from) {
  if (!sessions.has(from)) sessions.set(from, { step: "MENU", lastOrderId: null });
  return sessions.get(from);
}
function resetSession(from) {
  sessions.set(from, { step: "MENU", lastOrderId: null });
  return sessions.get(from);
}

// cache opcional: orderId -> phone (quando vier do WhatsApp)
const orderPhoneCache = new Map();

// ===== MENUS =====
async function showMainMenu(from) {
  await sendButtons(from, "🍕 *Pappi Pizza*\nComo posso te ajudar?", [
    { id: "BTN_PEDIR", title: "🛒 Fazer Pedido" },
    { id: "BTN_CARDAPIO", title: "📖 Cardápio" },
    { id: "BTN_STATUS", title: "📦 Status" },
  ]);
}

async function startCatalogFlow(from) {
  const catalog = await getCatalog();
  const categories = catalog.categories || [];
  const rows = categories.slice(0, 10).map((c) => ({
    id: `CAT_${c.id}`,
    title: c.name,
    description: "Ver opções",
  }));

  await sendList(from, "O que deseja pedir?", "Cardápio", [{ title: "Categorias", rows }]);
}

async function showItemsFromCategory(from, catId) {
  const session = getSession(from);
  const catalog = await getCatalog();
  const category = (catalog.categories || []).find((c) => String(c.id) === String(catId));

  if (!category) {
    await sendText(from, "Categoria não encontrada 😕");
    return showMainMenu(from);
  }

  session.selectedCategoryId = String(catId);
  session.selectedCategoryName = category.name;

  const items = category.items || [];
  const rows = items.slice(0, 10).map((item) => ({
    id: `ITEM_${item.id}`,
    title: item.name,
    description: item.price != null ? `R$ ${Number(item.price).toFixed(2)}` : (item.description || "Selecionar"),
  }));

  await sendList(from, `Opções de ${category.name}`, "Selecionar", [{ title: "Itens", rows }]);
}

async function confirmOrder(from, session) {
  const endereco =
    session.orderType === "delivery" && session.addressData
      ? session.addressData.formatted
      : "Retirada";

  const resumo =
    `📝 *Resumo do pedido*\n` +
    `🍽️ Item: *${session.selectedItemName || "—"}*\n` +
    `📏 Tamanho: *${session.selectedSize || "Padrão"}*\n` +
    `📍 ${endereco}\n\n` +
    `Se estiver certo, confirme:`;

  await sendButtons(from, resumo, [
    { id: "FINISH_ORDER", title: "✅ Confirmar" },
    { id: "BACK_MENU", title: "❌ Cancelar" },
  ]);
}

// ===== ENDEREÇO: confirmação robusta =====
async function confirmLocation(from, session, geoData) {
  session.addressData = geoData;

  const dist = distanceKm(
    STORE_LOCATION.lat,
    STORE_LOCATION.lng,
    geoData.location.lat,
    geoData.location.lng
  );

  await sendLocationImage(from, geoData.location.lat, geoData.location.lng, "📍 Local encontrado");

  if (dist > MAX_DELIVERY_RADIUS_KM) {
    await sendText(
      from,
      `⚠️ Esse endereço está a *${dist.toFixed(1)} km* da loja.\nRaio padrão: *${MAX_DELIVERY_RADIUS_KM} km*.\nPode haver taxa extra.`
    );
  } else {
    await sendText(from, `✅ Localizado: *${geoData.formatted}*\nDistância: *${dist.toFixed(1)} km*`);
  }

  await sendButtons(from, "Este é o local correto?", [
    { id: "ADDR_CONFIRM", title: "Sim, Confirmar" },
    { id: "ADDR_RETRY", title: "Corrigir" },
  ]);
}

// ===== WEBHOOK META (WhatsApp) =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  // WhatsApp quer 200 rápido
  res.sendStatus(200);

  try {
    const body = req.body;
    const entries = body?.entry || [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value;
        const messages = value?.messages || [];

        for (const msg of messages) {
          const from = msg.from;
          const text = msg.text?.body || "";
          const interactiveId =
            msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null;
          const interactiveTitle =
            msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || null;

          const session = getSession(from);
          const input = normalizeText(text);

          // ===== RESET / SAUDAÇÃO =====
          if (
            input === "menu" ||
            input === "inicio" ||
            input === "oi" ||
            input === "ola" ||
            input === "olá" ||
            interactiveId === "BACK_MENU"
          ) {
            resetSession(from);
            await sendText(from, "👋 Olá! Bem-vindo(a) à *Pappi Pizza* 🍕");
            await showMainMenu(from);
            continue;
          }

          // ===== STATUS (texto) =====
          const wantsStatus =
            input.includes("status") ||
            input.includes("meu pedido") ||
            input.includes("cade") ||
            input.includes("cadê") ||
            input.includes("atras") ||
            input.includes("demor");

          if (wantsStatus || interactiveId === "BTN_STATUS") {
            const orderId = extractOrderIdFromText(text) || session.lastOrderId;

            if (!orderId) {
              await sendText(from, "📦 Me manda o número do pedido pra eu consultar.\nEx: *status 7637462*");
              await showMainMenu(from);
              continue;
            }

            try {
              const order = await getOrderById(orderId);
              session.lastOrderId = String(orderId);
              await sendText(from, formatOrderStatus(order));

              if (order?.status === "confirmed") {
                await sendText(from, "🙏 Já está em preparo. Assim que atualizar no sistema, eu te aviso aqui.");
              }
            } catch (e) {
              console.error("status lookup error:", e?.message, e?.payload || "");
              await sendText(from, "Não consegui localizar esse pedido 😕\nConfere o número e manda de novo.\nEx: status 7637462");
            }

            await showMainMenu(from);
            continue;
          }

          // ===== MENU BUTTONS =====
          if (interactiveId === "BTN_CARDAPIO") {
            await sendText(from, "📖 Cardápio completo:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony");
            await sendButtons(from, "Quer pedir agora?", [
              { id: "BTN_PEDIR", title: "Sim, Pedir" },
              { id: "BACK_MENU", title: "Voltar" },
            ]);
            continue;
          }

          if (interactiveId === "BTN_PEDIR") {
            session.step = "ORDER_TYPE";
            await sendButtons(from, "É entrega ou retirada?", [
              { id: "TYPE_DELIVERY", title: "🛵 Entrega" },
              { id: "TYPE_TAKEOUT", title: "🏃 Retirada" },
            ]);
            continue;
          }

          // ===== TIPO DE PEDIDO =====
          if (interactiveId === "TYPE_DELIVERY") {
            session.orderType = "delivery";
            session.step = "ASK_ADDRESS";
            await sendText(from, "📍 *Entrega*\nDigite seu endereço (Rua, Número e Bairro).");
            continue;
          }

          if (interactiveId === "TYPE_TAKEOUT") {
            session.orderType = "takeout";
            session.step = "SELECT_CATEGORY";
            await startCatalogFlow(from);
            continue;
          }

          // ===== ENDEREÇO (geocode + lista) =====
          if (session.step === "ASK_ADDRESS" && !interactiveId) {
            if (input.length < 6) {
              await sendText(from, "❌ Endereço muito curto. Digite *Rua, Número e Bairro*.");
              continue;
            }

            if (!GOOGLE_MAPS_KEY) {
              // sem maps: aceita texto e segue (sem validação)
              session.addressData = { formatted: text, location: null, placeId: null };
              session.step = "SELECT_CATEGORY";
              await sendText(from, "✅ Endereço anotado! Vamos ao pedido 🍕");
              await startCatalogFlow(from);
              continue;
            }

            await sendText(from, "🔎 Pesquisando endereço...");
            const results = await googleGeocode(text);

            if (!results.length) {
              await sendText(from, "❌ Não encontrei. Tente assim:\nRua X, 123, Bairro Y");
              continue;
            }

            if (results.length === 1) {
              await confirmLocation(from, session, results[0]);
              continue;
            }

            session.candidateAddresses = results;
            const rows = results.map((addr, index) => ({
              id: `ADDR_OPT_${index}`,
              title: (addr.formatted.split(",")[0] || "Opção").slice(0, 23),
              description: addr.formatted.slice(0, 70),
            }));

            await sendList(from, "Selecione o endereço correto:", "Endereços", [{ title: "Opções", rows }]);
            continue;
          }

          if (interactiveId && interactiveId.startsWith("ADDR_OPT_")) {
            const index = Number(interactiveId.replace("ADDR_OPT_", ""));
            const chosen = session.candidateAddresses?.[index];
            if (!chosen) {
              await sendText(from, "Opção inválida 😕 Digite o endereço novamente.");
              session.step = "ASK_ADDRESS";
              continue;
            }
            await confirmLocation(from, session, chosen);
            continue;
          }

          if (interactiveId === "ADDR_RETRY") {
            session.step = "ASK_ADDRESS";
            await sendText(from, "Beleza! Digite o endereço novamente:");
            continue;
          }

          if (interactiveId === "ADDR_CONFIRM") {
            session.step = "SELECT_CATEGORY";
            await sendText(from, "✅ Endereço confirmado! Vamos ao pedido 🍕");
            await startCatalogFlow(from);
            continue;
          }

          // ===== CATÁLOGO =====
          if (interactiveId && interactiveId.startsWith("CAT_")) {
            const catId = interactiveId.replace("CAT_", "");
            await showItemsFromCategory(from, catId);
            continue;
          }

          if (interactiveId && interactiveId.startsWith("ITEM_")) {
            const itemId = interactiveId.replace("ITEM_", "");

            session.selectedItemId = itemId;
            session.selectedItemName = interactiveTitle || "Item selecionado";

            const isPizza = normalizeText(session.selectedCategoryName || "").includes("pizza");
            if (isPizza) {
              session.step = "SELECT_SIZE";
              await sendText(from, `🍕 Sabor: *${session.selectedItemName}*`);
              await sendButtons(from, "Escolha o tamanho:", [
                { id: "SIZE_BROTO", title: "Brotinho (4)" },
                { id: "SIZE_GRANDE", title: "Grande (8)" },
                { id: "SIZE_GIGANTE", title: "Gigante (16)" },
              ]);
            } else {
              session.selectedSize = "Padrão";
              session.step = "CONFIRM_ORDER";
              await confirmOrder(from, session);
            }
            continue;
          }

          if (interactiveId && interactiveId.startsWith("SIZE_")) {
            session.selectedSize = interactiveTitle || "Tamanho selecionado";
            session.step = "CONFIRM_ORDER";
            await confirmOrder(from, session);
            continue;
          }

          // ===== FINALIZAR (humano) =====
          if (interactiveId === "FINISH_ORDER") {
            const endereco =
              session.orderType === "delivery" && session.addressData
                ? session.addressData.formatted
                : "Retirada";

            const msgResumo =
              `Novo Pedido:\n` +
              `Item: ${session.selectedItemName}\n` +
              `Tamanho: ${session.selectedSize}\n` +
              `Tipo: ${session.orderType}\n` +
              `Endereço: ${endereco}`;

            const linkCheckout = `https://wa.me/${ATTENDANT_WA_PHONE}?text=${encodeURIComponent(msgResumo)}`;

            await sendText(
              from,
              `✅ Pedido enviado!\nUm atendente vai confirmar o total.\n\nFinalize por aqui:\n${linkCheckout}`
            );

            resetSession(from);
            continue;
          }

          // ===== FALLBACK =====
          await sendText(from, "Entendi 🙂 Para agilizar, escolha uma opção:");
          await showMainMenu(from);
        }
      }
    }
  } catch (e) {
    console.error("Webhook Meta error:", e?.message || e);
  }
});

// ===== WEBHOOK Cardápio Web (status mudou) =====
// Configure no portal para: https://SEU_DOMINIO.onrender.com/cardapioweb/webhook
app.post("/cardapioweb/webhook", async (req, res) => {
  // precisa responder 200 em até 5s
  res.status(200).json({ ok: true });

  try {
    if (CARDAPIOWEB_WEBHOOK_TOKEN) {
      const token = req.header("X-Webhook-Token") || "";
      if (token !== CARDAPIOWEB_WEBHOOK_TOKEN) {
        console.warn("Cardápio Web webhook: token inválido");
        return;
      }
    }

    const body = req.body || {};

    // tenta extrair orderId (formato pode variar)
    const orderId =
      body?.order_id ||
      body?.data?.order_id ||
      body?.data?.id ||
      body?.resource_id ||
      body?.order?.id ||
      body?.id ||
      null;

    if (!orderId) {
      console.log("Cardápio Web webhook recebido sem orderId:", body);
      return;
    }

    // busca pedido atualizado
    const order = await getOrderById(orderId);

    // tenta pegar telefone do pedido; fallback cache
    const phone =
      digitsOnly(order?.customer?.phone || "") ||
      orderPhoneCache.get(String(orderId)) ||
      null;

    if (!phone) {
      console.log("Webhook: pedido sem phone (customer null). orderId:", orderId);
      return;
    }

    // notifica status
    await sendText(phone, formatOrderStatus(order));

    if (order?.status === "confirmed") {
      await sendText(phone, "🙏 Já está em preparo. Assim que mudar no sistema, eu te aviso aqui.");
    }
  } catch (e) {
    console.error("Cardápio Web webhook error:", e?.message, e?.payload || "");
  }
});

// ===== Health =====
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "pappi-api",
    hasWhatsapp: Boolean(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID),
    hasCardapioWeb: Boolean(CARDAPIOWEB_TOKEN),
    hasMaps: Boolean(GOOGLE_MAPS_KEY),
  });
});

// ===== Run =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🔥 Pappi API rodando na porta ${PORT}`));
