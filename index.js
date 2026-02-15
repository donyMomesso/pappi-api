/**
 * Pappi Pizza API - WhatsApp Cloud + Cardápio Web + Google Address Confirm + Maps Quote/Reverse
 * Node 18+ (fetch nativo)
 *
 * ✅ Fluxo humanizado + carrinho (multi-pizza) + observação por item + upsell
 * ✅ Endereço do delivery SÓ avança se confirmar no Google (texto OU localização)
 * ✅ Calcula KM/ETA/Frete por regra (0-2=5 | 2-3=8 | 3-6=12 | 6-10=15 | >10 não atende)
 * ✅ Consulta "status 7637462" (Cardápio Web) + mapeamento amigável
 * ✅ Endpoints internos (pra Actions/Swagger):
 *    GET    /store
 *    GET    /catalog
 *    POST   /orders
 *    GET    /orders/:orderId
 *    PATCH  /orders/:orderId/status
 *    POST   /customers
 *    POST   /checkout/whatsapp
 * ✅ Webhooks:
 *    /webhook (Meta WhatsApp)
 *    /cardapioweb/webhook (Webhook do Cardápio Web - opcional)
 * ✅ Maps:
 *    GET /maps/quote?address=...
 *    GET /maps/reverse?lat=...&lng=...
 */

const express = require("express");
const app = express();
app.use(express.json({ limit: "10mb" }));

// ======================================================
// 1) ENV / CONFIG
// ======================================================
const PORT = process.env.PORT || 10000;

// --- Proteção para endpoints internos (Swagger/Actions) ---
const ATTENDANT_API_KEY = process.env.ATTENDANT_API_KEY || ""; // seu "X-API-Key" dos endpoints internos

// --- WhatsApp Cloud ---
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim().replace(/\s+/g, ""); // evita "Malformed token"
const WHATSAPP_PHONE_NUMBER_ID = (process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
const WEBHOOK_VERIFY_TOKEN = (process.env.WEBHOOK_VERIFY_TOKEN || "").trim();

// --- Cardápio Web (produção) ---
const CARDAPIOWEB_BASE_URL = process.env.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
const CARDAPIOWEB_TOKEN = (process.env.CARDAPIOWEB_TOKEN || "").trim(); // X-API-KEY do CardápioWeb Partner
const CARDAPIOWEB_STORE_ID = (process.env.CARDAPIOWEB_STORE_ID || "").trim(); // se a sua conta exigir

// --- Webhook token do Cardápio Web (opcional) ---
const CARDAPIOWEB_WEBHOOK_TOKEN = (process.env.CARDAPIOWEB_WEBHOOK_TOKEN || "").trim(); // validado no header X-Webhook-Token

// --- Google (confirmar endereço / reverse / quote) ---
// Padronizado para seu Render: GOOGLE_MAPS_API_KEY
const GOOGLE_MAPS_KEY = (process.env.GOOGLE_MAPS_API_KEY || "").trim();

// Loja (pra sugerir Campinas automaticamente)
const DEFAULT_CITY = "Campinas";
const DEFAULT_STATE = "SP";
const DEFAULT_COUNTRY = "BR";

// Coordenadas da loja (Render env):
const STORE_LAT = Number(process.env.STORE_LAT);
const STORE_LNG = Number(process.env.STORE_LNG);

// WhatsApp do atendimento (finalizar com humano)
const HUMAN_WA_NUMBER = process.env.HUMAN_WA_NUMBER || "5519982275105"; // ajuste se quiser

// ======================================================
// 2) HELPERS
// ======================================================
function nowIso() {
  return new Date().toISOString();
}
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
function safeJsonParse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}
function pickFirstNonEmpty(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  return null;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}

// ======================================================
// 3) WHATSAPP SEND
// ======================================================
async function waSend(payload) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurados.");
  }
  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || `Erro WhatsApp (${resp.status})`;
    const err = new Error(msg);
    err.status = resp.status;
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
    text: { body: text },
  });
}

// Botões (máx 3)
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
          reply: { id: b.id, title: String(b.title || "").slice(0, 20) },
        })),
      },
    },
  });
}

// Lista (para muitas opções)
async function sendList(to, bodyText, buttonText, sections /* [{title, rows}] */) {
  const safeSections = (sections || []).slice(0, 10).map((s) => ({
    title: String(s.title || "Opções").slice(0, 24),
    rows: (s.rows || []).slice(0, 10).map((r) => ({
      id: String(r.id).slice(0, 200),
      title: String(r.title || "").slice(0, 24),
      description: r.description ? String(r.description).slice(0, 72) : undefined,
    })),
  }));

  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: { button: String(buttonText || "Ver").slice(0, 20), sections: safeSections },
    },
  });
}

// ======================================================
// 4) CARDÁPIO WEB API (Partner)
// ======================================================
async function cardapioWebFetch(path, { method = "GET", body } = {}) {
  if (!CARDAPIOWEB_TOKEN) {
    const err = new Error("CARDAPIOWEB_TOKEN não configurado no Render (Environment).");
    err.status = 401;
    throw err;
  }

  const url = `${CARDAPIOWEB_BASE_URL}${path}`;
  const headers = {
    "X-API-KEY": CARDAPIOWEB_TOKEN,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (CARDAPIOWEB_STORE_ID) headers["X-STORE-ID"] = String(CARDAPIOWEB_STORE_ID);

  const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  const data = safeJsonParse(text);

  if (!resp.ok) {
    const msg = data?.message || data?.error || text || "Erro Cardápio Web";
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

// Catálogo
async function getCatalog() {
  return cardapioWebFetch(`/api/partner/v1/catalog`);
}

// Pedido por ID (status)
async function getOrderById(orderId) {
  return cardapioWebFetch(`/api/partner/v1/orders/${encodeURIComponent(String(orderId))}`);
}

// Marcar pronto (exemplo do doc)
async function markOrderReady(orderId) {
  return cardapioWebFetch(`/api/partner/v1/orders/${encodeURIComponent(String(orderId))}/ready`, {
    method: "POST",
    body: {},
  });
}

// ======================================================
// 5) GOOGLE (geocode / reverse / distance)
// ======================================================
async function googleGeocodeCandidates(addressText) {
  if (!GOOGLE_MAPS_KEY) return [];

  const raw = String(addressText || "").trim();
  if (raw.length < 6) return [];

  const hasCity = normalizeText(raw).includes(normalizeText(DEFAULT_CITY));
  const query = hasCity ? raw : `${raw}, ${DEFAULT_CITY} - ${DEFAULT_STATE}`;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    query
  )}&components=country:${DEFAULT_COUNTRY}&key=${GOOGLE_MAPS_KEY}&language=pt-BR`;

  try {
    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    if (data.status !== "OK" || !Array.isArray(data.results)) return [];

    return data.results.slice(0, 5).map((r) => ({
      formatted: r.formatted_address,
      location: r.geometry?.location, // {lat,lng}
      placeId: r.place_id,
      raw: r,
    }));
  } catch (e) {
    console.error("Google geocode error:", e);
    return [];
  }
}

async function googleReverseGeocode(lat, lng) {
  if (!GOOGLE_MAPS_KEY) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(
    `${lat},${lng}`
  )}&key=${GOOGLE_MAPS_KEY}&language=pt-BR`;

  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));

  if (data.status !== "OK" || !data.results?.length) return null;
  const best = data.results[0];
  return {
    formatted: best.formatted_address,
    location: { lat, lng },
    placeId: best.place_id,
    raw: best,
  };
}

function calcDeliveryFeeKm(km) {
  // REGRA DO DONY (limpa e final)
  // 0-2 = 5 | 2-3 = 8 | 3-6 = 12 | 6-10 = 15 | >10 = null (fora do raio)
  if (km <= 2) return 5;
  if (km <= 3) return 8;
  if (km <= 6) return 12;
  if (km <= 10) return 15;
  return null;
}

async function mapsQuoteByLatLng(destLat, destLng) {
  if (!GOOGLE_MAPS_KEY) {
    return { ok: false, error: "missing_google_maps_key" };
  }
  if (!Number.isFinite(STORE_LAT) || !Number.isFinite(STORE_LNG)) {
    return { ok: false, error: "missing_store_lat_lng" };
  }
  if (!Number.isFinite(destLat) || !Number.isFinite(destLng)) {
    return { ok: false, error: "lat_lng_required" };
  }

  const dmUrl = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  dmUrl.searchParams.set("origins", `${STORE_LAT},${STORE_LNG}`);
  dmUrl.searchParams.set("destinations", `${destLat},${destLng}`);
  dmUrl.searchParams.set("mode", "driving");
  dmUrl.searchParams.set("language", "pt-BR");
  dmUrl.searchParams.set("key", GOOGLE_MAPS_KEY);

  const dmRes = await fetch(dmUrl);
  const dm = await dmRes.json().catch(() => ({}));
  const el = dm?.rows?.[0]?.elements?.[0];

  if (!el || el.status !== "OK") {
    return { ok: false, error: "distance_failed", detail: el?.status || null, dm };
  }

  const km = round1(el.distance.value / 1000);
  const eta_minutes = Math.round(el.duration.value / 60);
  const delivery_fee = calcDeliveryFeeKm(km);

  return {
    ok: true,
    km,
    eta_minutes,
    delivery_fee,
    is_serviceable: delivery_fee !== null,
  };
}

// ======================================================
// 6) SESSÕES + MAPAS
// ======================================================
/**
 * session = {
 *   step: string,
 *   customer: { name, phone },
 *   fulfillment: {
 *     type: delivery|takeout|null,
 *     requested_at,
 *     address: {street,number,neighborhood,city,state,zip,complement,reference}|null,
 *     address_confirmed: boolean,
 *     google: {formatted,location,placeId}|null,
 *     quote: {km,eta_minutes,delivery_fee,is_serviceable}|null
 *   },
 *   cart: [...],
 *   draftItem: {...},
 *   addressCandidates: [...],
 * }
 */
const sessions = new Map();
// mapa simples: orderId -> whatsappPhone (pra webhook de status notificar)
const orderPhoneIndex = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      step: "MENU",
      customer: { name: null, phone },
      fulfillment: {
        type: null, // delivery|takeout
        requested_at: null,
        address: null,
        address_confirmed: false,
        google: null,
        quote: null,
      },
      cart: [],
      draftItem: null,
      lastOrderId: null,
      lastOrderDisplayId: null,
      addressCandidates: null,
    });
  }
  return sessions.get(phone);
}
function resetSession(phone) {
  sessions.delete(phone);
  return getSession(phone);
}

// ======================================================
// 7) ESTRUTURA PADRÃO (QUE VOCÊ PEDIU) - MONTADORES
// ======================================================
function buildOrderPayloadFromSession(session) {
  const payload = {
    channel: "whatsapp",
    store_id: "pappi_pizza",
    customer: {
      name: pickFirstNonEmpty(session.customer?.name, "Cliente"),
      phone: `+${digitsOnly(session.customer?.phone || "")}`,
    },
    fulfillment: {
      type: session.fulfillment?.type || "delivery",
      requested_at: session.fulfillment?.requested_at || null,
      address: session.fulfillment?.type === "delivery" ? session.fulfillment?.address || null : null,
      google_formatted: session.fulfillment?.google?.formatted || null,
      delivery_km: session.fulfillment?.quote?.km ?? null,
      delivery_eta_minutes: session.fulfillment?.quote?.eta_minutes ?? null,
    },
    items: (session.cart || []).map((it) => ({
      item_id: Number(it.item_id),
      name: it.name,
      quantity: Number(it.quantity || 1),
      unit_price: it.unit_price ?? null,
      notes: it.notes || null,
      modifiers: (it.modifiers || []).map((m) => ({
        modifier_id: Number(m.modifier_id),
        name: m.name,
        quantity: Number(m.quantity || 1),
        unit_price: m.unit_price ?? null,
      })),
    })),
    pricing: {
      subtotal: null,
      discount: { type: "fixed", value: 0, coupon: null },
      delivery_fee: session.fulfillment?.quote?.delivery_fee ?? null,
      service_fee: 0,
      total: null,
    },
    payment: {
      method: session.payment?.method || null,
      status: session.payment?.status || null,
      change_for: session.payment?.change_for ?? null,
    },
    notes: session.notes || null,
    meta: {
      conversation_id: `wa_${digitsOnly(session.customer?.phone || "")}`,
      gpt_session_id: session.gpt_session_id || null,
      client_ip: null,
    },
  };

  return payload;
}

function buildCreatedOrderResponse({ order_id }) {
  return {
    order_id: String(order_id || ""),
    status: "created",
    created_at: nowIso(),
    estimated_delivery_minutes: null,
    payment: { method: null, status: "pending", pix: { qr_code: null, copy_paste: null } },
    pricing: { subtotal: null, discount: 0, delivery_fee: null, service_fee: 0, total: null },
  };
}

// ======================================================
// 8) CATÁLOGO: helpers pra mostrar categorias/itens e achar por texto
// ======================================================
async function catalogGetSafe() {
  try {
    return await getCatalog();
  } catch (e) {
    console.error("Catalog error:", e?.message, e?.payload || "");
    return { categories: [] };
  }
}

function findCategoryByName(catalog, needle) {
  const n = normalizeText(needle);
  return (catalog?.categories || []).find((c) => normalizeText(c?.name).includes(n));
}

function findItemByNameInCatalog(catalog, itemName) {
  const n = normalizeText(itemName);
  for (const c of catalog?.categories || []) {
    for (const it of c?.items || []) {
      if (normalizeText(it?.name) === n) return it;
      if (normalizeText(it?.name).includes(n)) return it;
    }
  }
  return null;
}

async function showCategories(from) {
  const catalog = await catalogGetSafe();
  const categories = (catalog?.categories || []).filter((c) => c?.status === "ACTIVE");

  if (categories.length === 0) {
    await sendText(
      from,
      `Tô sem acesso ao cardápio automático agora 😕\nMas você pode ver aqui:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony\n\nMe diga o sabor (ex: "calabresa") que eu monto seu pedido 😉`
    );
    return;
  }

  const rows = categories.slice(0, 10).map((c) => ({
    id: `CAT_${c.id}`,
    title: c.name,
    description: "Ver opções",
  }));

  await sendList(from, "Boa! O que você quer pedir hoje? 😄", "Ver categorias", [
    { title: "Categorias", rows },
  ]);
}

async function showItemsFromCategory(from, catId) {
  const catalog = await catalogGetSafe();
  const category = (catalog?.categories || []).find((c) => String(c.id) === String(catId));
  if (!category) {
    await sendText(from, "Não achei essa categoria 😕. Bora tentar de novo.");
    await showCategories(from);
    return;
  }

  const items = (category.items || []).filter((it) => it?.status === "ACTIVE");
  if (items.length === 0) {
    await sendText(from, "Essa categoria tá sem itens agora. Quer outra? 🙂");
    await showCategories(from);
    return;
  }

  const rows = items.slice(0, 10).map((it) => ({
    id: `ITEM_${it.id}`,
    title: it.name,
    description: it.description ? normalizeText(it.description).slice(0, 60) : "Selecionar",
  }));

  await sendList(from, `Top! Escolhe 1 item de *${category.name}* 👇`, "Ver itens", [
    { title: "Itens", rows },
  ]);
}

async function showOptionGroupAsList(from, og, prefixId) {
  const rows = (og?.options || [])
    .filter((o) => o?.status === "ACTIVE")
    .slice(0, 10)
    .map((o) => ({
      id: `${prefixId}_OPT_${o.id}`,
      title: o.name,
      description: og.name,
    }));

  await sendList(from, `Agora escolhe *${og.name}* 🙂`, "Ver opções", [{ title: og.name, rows }]);
}

// ======================================================
// 9) UX / MENSAGENS (humanizado + upsell + carrinho)
// ======================================================
async function showMainMenu(from) {
  await sendButtons(from, "🍕 Pappi Pizza\nMe fala o que você prefere fazer agora:", [
    { id: "MENU_PEDIR", title: "🛒 Fazer pedido" },
    { id: "MENU_CARDAPIO", title: "📖 Cardápio" },
    { id: "MENU_STATUS", title: "📦 Status pedido" },
  ]);
}

async function askOrderType(from) {
  await sendButtons(from, "Show 🙂 É *entrega* ou *retirada*?", [
    { id: "TYPE_DELIVERY", title: "🛵 Entrega" },
    { id: "TYPE_TAKEOUT", title: "🏃 Retirada" },
    { id: "BACK_MENU", title: "⬅️ Menu" },
  ]);
}

async function askAddress(from) {
  await sendText(
    from,
    `Perfeito. Você pode mandar:\n\n1) *Endereço* (rua, número - bairro)\n2) *Ou a sua localização* (📎 → Localização)\n\nEx: Rua Rodolfo Gotardelo, 35 - Jardim das Bandeiras`
  );
}

async function confirmAddressFromCandidates(from, session, candidates) {
  if (!candidates || candidates.length === 0) {
    await sendText(
      from,
      "Não consegui confirmar esse endereço no Google 😕\nTenta mandar com *rua + número + bairro* ou envie a *localização*."
    );
    session.step = "ASK_ADDRESS";
    return;
  }

  if (candidates.length === 1) {
    session.addressCandidates = candidates;
    session.step = "CONFIRM_ADDRESS";
    const one = candidates[0];
    await sendText(from, `Encontrei este endereço:\n*${one.formatted}*\n\nConfirma pra mim? 🙂`);
    await sendButtons(from, "Está correto?", [
      { id: "ADDR_CONFIRM_0", title: "✅ Confirmar" },
      { id: "ADDR_RETRY", title: "✏️ Corrigir" },
      { id: "BACK_MENU", title: "⬅️ Menu" },
    ]);
    return;
  }

  session.addressCandidates = candidates;
  session.step = "PICK_ADDRESS";

  const rows = candidates.slice(0, 5).map((c, idx) => ({
    id: `ADDR_PICK_${idx}`,
    title: (c.formatted.split(",")[0] || "Endereço").slice(0, 23),
    description: c.formatted.slice(0, 70),
  }));

  await sendList(from, "Achei algumas opções no Google. Qual é a certa? 🙂", "Ver endereços", [
    { title: "Endereços", rows },
  ]);
}

async function askAnythingElse(from) {
  await sendButtons(from, "Quer adicionar mais alguma coisa no pedido? 😋", [
    { id: "ADD_MORE", title: "➕ Sim" },
    { id: "ADD_NO", title: "✅ Não" },
    { id: "BACK_MENU", title: "⬅️ Menu" },
  ]);
}

async function upsellNudge(from) {
  await sendButtons(from, "Dica rápida 😄 Quer colocar uma bebida junto pra fechar perfeito?", [
    { id: "UPSELL_DRINKS", title: "🥤 Ver bebidas" },
    { id: "UPSELL_SKIP", title: "Agora não" },
    { id: "BACK_MENU", title: "⬅️ Menu" },
  ]);
}

async function askItemObservation(from, itemName) {
  await sendButtons(from, `Beleza! Alguma observação pra *${itemName}*?`, [
    { id: "OBS_NONE", title: "Sem obs." },
    { id: "OBS_WRITE", title: "✍️ Escrever" },
    { id: "BACK_MENU", title: "⬅️ Menu" },
  ]);
}

async function sendCartSummary(from, session) {
  if (!session.cart || session.cart.length === 0) {
    await sendText(from, "Seu carrinho ainda tá vazio 🙂 Quer escolher algo?");
    await showCategories(from);
    return;
  }

  const lines = session.cart.map((it, i) => {
    const mods = (it.modifiers || []).map((m) => m.name).filter(Boolean);
    const obs = it.notes ? ` | Obs: ${it.notes}` : "";
    const modText = mods.length ? ` | Extras: ${mods.join(", ")}` : "";
    return `${i + 1}) ${it.quantity}x ${it.name}${modText}${obs}`;
  });

  const header =
    session.fulfillment?.type === "delivery"
      ? `📍 Entrega: ${session.fulfillment?.google?.formatted || "(confirmado no Google)"}`
      : `🏃 Retirada na loja`;

  const quote = session.fulfillment?.quote?.ok
    ? `\n🛵 Frete: R$${session.fulfillment.quote.delivery_fee} | ${session.fulfillment.quote.km} km | ~${session.fulfillment.quote.eta_minutes} min`
    : "";

  await sendText(from, `🧾 *Seu pedido até agora*\n${header}${quote}\n\n${lines.join("\n")}`);
}

async function finalizeToHuman(from, session) {
  const orderPayload = buildOrderPayloadFromSession(session);

  const text =
    `Novo pedido (bot)\n` +
    `Cliente: ${orderPayload.customer.name}\n` +
    `Telefone: ${orderPayload.customer.phone}\n` +
    `Tipo: ${orderPayload.fulfillment.type}\n` +
    (orderPayload.fulfillment.type === "delivery" && orderPayload.fulfillment.address
      ? `Endereço (Google): ${orderPayload.fulfillment.google_formatted || "-"}\n` +
        `KM/ETA: ${orderPayload.fulfillment.delivery_km ?? "-"} km / ${orderPayload.fulfillment.delivery_eta_minutes ?? "-"} min\n` +
        `Frete: R$${orderPayload.pricing.delivery_fee ?? "-"}\n` +
        `Endereço (campos): ${orderPayload.fulfillment.address.street || ""} ${orderPayload.fulfillment.address.number || ""} - ${
          orderPayload.fulfillment.address.neighborhood || ""
        }\nCompl: ${orderPayload.fulfillment.address.complement || "-"}\nRef: ${orderPayload.fulfillment.address.reference || "-"}\n`
      : "") +
    `Itens:\n` +
    orderPayload.items
      .map((it) => {
        const mods = (it.modifiers || []).map((m) => `+ ${m.name}`).join(", ");
        return `- ${it.quantity}x ${it.name}${mods ? ` (${mods})` : ""}${it.notes ? ` | Obs: ${it.notes}` : ""}`;
      })
      .join("\n");

  const linkCheckout = `https://wa.me/${digitsOnly(HUMAN_WA_NUMBER)}?text=${encodeURIComponent(text)}`;

  await sendText(from, `✅ Fechou! Vou te passar pro atendimento só pra confirmar e finalizar.\n\n👉 ${linkCheckout}`);
  resetSession(from);
}

// ======================================================
// 10) STATUS (Cardápio Web) - parser e resposta
// ======================================================
function extractStatusOrderIdFromText(text) {
  const t = normalizeText(text);
  const m = t.match(/\b(status|pedido|meu pedido)\s*(#|:)?\s*([0-9]{3,})\b/);
  if (!m) return null;
  return m[3];
}

function mapOrderStatusPt(status) {
  const map = {
    waiting_confirmation: "Aguardando confirmação",
    pending_payment: "Pagamento pendente",
    pending_online_payment: "Aguardando pagamento online",
    scheduled_confirmed: "Agendado confirmado",
    confirmed: "Confirmado / em preparo",
    ready: "Pronto (ainda não saiu)",
    released: "Saiu para entrega",
    waiting_to_catch: "Pronto aguardando retirada",
    delivered: "Entregue",
    canceling: "Cancelando",
    canceled: "Cancelado",
    closed: "Finalizado",
  };
  return map[status] || status || "—";
}

async function handleStatusInquiry(from, orderId) {
  try {
    await sendText(from, "🔎 Consultando o status do seu pedido no sistema…");

    const order = await getOrderById(orderId);
    const st = order?.status;
    const pt = mapOrderStatusPt(st);

    const when = order?.estimated_time != null ? `\n⏱️ Previsão: ~${order.estimated_time} min` : "";
    const type = order?.order_type ? `\n📦 Tipo: ${order.order_type}` : "";
    const disp = order?.display_id != null ? `\n🧾 Nº: ${order.display_id}` : "";

    await sendText(
      from,
      `✅ Status do pedido *${orderId}*:${disp}\n*${pt}*${type}${when}\n\nSe estiver demorando, eu fico de olho e te aviso 🙏`
    );
  } catch (e) {
    const isToken =
      String(e?.message || "").toLowerCase().includes("token") || e?.status === 401 || e?.status === 403;
    if (isToken) {
      await sendText(
        from,
        "Tô sem acesso ao sistema de status agora 😕\n(autenticação do Cardápio Web)\n\nMe chama um atendente que a gente confere rapidinho."
      );
    } else {
      await sendText(from, "Não consegui localizar esse pedido 😕\nConfere o número e manda de novo.\nEx: status 7637462");
    }
  }
}

// ======================================================
// 11) EXTRAÇÃO DE MENSAGENS (Webhook Meta)
// ======================================================
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
          id: m.id,
          type: m.type,
          text: m.text?.body || "",
          location: m.location || null,
          interactive: m.interactive?.button_reply || m.interactive?.list_reply || null,
          raw: m,
        });
      }
    }
  }
  return out;
}

// ======================================================
// 12) ROTAS BÁSICAS + DEBUG
// ======================================================
app.get("/", (req, res) => res.status(200).send("Pappi API online ✅"));

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    app: "API da Pappi Pizza",
    time: nowIso(),
  });
});
app.get("/meta", (req, res) => {
  res.status(200).json({
    ok: true,
    app: "API da Pappi Pizza",
    version: "1.1.0",
    env: {
      hasWhatsapp: Boolean(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID),
      hasCardapioWeb: Boolean(CARDAPIOWEB_TOKEN),
      hasGoogleMaps: Boolean(GOOGLE_MAPS_KEY),
      hasStoreLatLng: Number.isFinite(STORE_LAT) && Number.isFinite(STORE_LNG),
    },
    store: {
      id: "pappi_pizza",
      name: "Pappi Pizza",
      city: DEFAULT_CITY,
      state: DEFAULT_STATE,
      menu_url: "https://app.cardapioweb.com/pappi_pizza?s=dony",
      whatsapp_human: HUMAN_WA_NUMBER
    },
    endpoints: {
      public: ["/", "/health", "/meta", "/debug-auth", "/maps/quote", "/maps/reverse"],
      internal: ["/store", "/catalog", "/customers", "/orders", "/orders/{orderId}", "/orders/{orderId}/status", "/checkout/whatsapp"],
      webhooks: ["/webhook", "/cardapioweb/webhook"]
    },
    time: nowIso()
  });
});

app.get("/debug-auth", (req, res) => {
  res.status(200).json({
    ok: true,
    hasAttendantKey: Boolean(ATTENDANT_API_KEY),
    hasWhatsappToken: Boolean(WHATSAPP_TOKEN),
    hasWhatsappPhoneNumberId: Boolean(WHATSAPP_PHONE_NUMBER_ID),
    hasWebhookVerifyToken: Boolean(WEBHOOK_VERIFY_TOKEN),
    cardapioWebBaseUrl: CARDAPIOWEB_BASE_URL,
    hasCardapioWebToken: Boolean(CARDAPIOWEB_TOKEN),
    hasCardapioWebStoreId: Boolean(CARDAPIOWEB_STORE_ID),
    hasGoogleMapsKey: Boolean(GOOGLE_MAPS_KEY),
    hasStoreLatLng: Number.isFinite(STORE_LAT) && Number.isFinite(STORE_LNG),
    hasCardapioWebWebhookToken: Boolean(CARDAPIOWEB_WEBHOOK_TOKEN),
  });
});

// ======================================================
// 12.1) MAPS (Quote / Reverse)
// ======================================================

// GET /maps/quote?address=...
app.get("/maps/quote", async (req, res) => {
  try {
    const address = String(req.query.address || "").trim();
    if (!address) return res.status(400).json({ error: "address_required" });

    const candidates = await googleGeocodeCandidates(address);
    if (!candidates.length || !candidates[0]?.location) {
      return res.status(422).json({ error: "geocode_failed", status: "NO_RESULTS" });
    }

    const best = candidates[0];
    const loc = best.location;

    const quote = await mapsQuoteByLatLng(Number(loc.lat), Number(loc.lng));
    if (!quote.ok) return res.status(422).json(quote);

    return res.json({
      store: { lat: STORE_LAT, lng: STORE_LNG },
      address_input: address,
      address_formatted: best.formatted,
      place_id: best.placeId,
      location: loc,
      ...quote,
      message: quote.is_serviceable ? null : "Infelizmente ainda não entregamos nessa região 🙏",
    });
  } catch (e) {
    console.error("maps/quote error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

// GET /maps/reverse?lat=...&lng=...
app.get("/maps/reverse", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);

    if (!GOOGLE_MAPS_KEY) return res.status(500).json({ error: "missing_google_maps_key" });
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "lat_lng_required" });

    const best = await googleReverseGeocode(lat, lng);
    if (!best) return res.status(422).json({ error: "reverse_geocode_failed" });

    return res.json({
      lat,
      lng,
      formatted_address: best.formatted,
      place_id: best.placeId,
    });
  } catch (e) {
    console.error("maps/reverse error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

// ======================================================
// 13) ENDPOINTS INTERNOS (Swagger/Actions) + AUTH
// ======================================================
function requireApiKey(req, res, next) {
  if (!ATTENDANT_API_KEY) return res.status(500).json({ error: "ATTENDANT_API_KEY não configurado." });
  const key = req.header("X-API-Key") || "";
  if (key !== ATTENDANT_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// GET /store
app.get("/store", requireApiKey, async (req, res) => {
  res.json({
    store_id: "pappi_pizza",
    name: "Pappi Pizza",
    city: DEFAULT_CITY,
    state: DEFAULT_STATE,
    menu_url: "https://app.cardapioweb.com/pappi_pizza?s=dony",
    store_location: Number.isFinite(STORE_LAT) && Number.isFinite(STORE_LNG) ? { lat: STORE_LAT, lng: STORE_LNG } : null,
  });
});

// GET /catalog
app.get("/catalog", requireApiKey, async (req, res) => {
  try {
    const catalog = await getCatalog();
    res.json(catalog);
  } catch (e) {
    res.status(e?.status || 500).json({ error: e?.message || "Erro catálogo", details: e?.payload || null });
  }
});

// POST /customers
app.post("/customers", requireApiKey, async (req, res) => {
  const { name, phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
  res.json({ ok: true, customer: { name: name || null, phone: String(phone) } });
});

// POST /orders (cria pedido interno no seu padrão)
app.post("/orders", requireApiKey, async (req, res) => {
  const body = req.body || {};
  if (!body.customer?.phone) return res.status(400).json({ error: "customer.phone é obrigatório" });
  res.json(buildCreatedOrderResponse({ order_id: body.order_id || `ORD-${Date.now()}` }));
});

// GET /orders/:orderId (consulta Cardápio Web)
app.get("/orders/:orderId", requireApiKey, async (req, res) => {
  try {
    const data = await getOrderById(req.params.orderId);
    res.json(data);
  } catch (e) {
    res.status(e?.status || 500).json({ error: e?.message || "Erro consulta", details: e?.payload || null });
  }
});

// PATCH /orders/:orderId/status (ex: marcar pronto)
app.patch("/orders/:orderId/status", requireApiKey, async (req, res) => {
  const { status } = req.body || {};
  try {
    if (status === "ready") {
      const data = await markOrderReady(req.params.orderId);
      res.json({ ok: true, updated: true, data });
      return;
    }
    res.status(400).json({ error: "Status não suportado neste endpoint. Use status='ready'." });
  } catch (e) {
    res.status(e?.status || 500).json({ error: e?.message || "Erro status", details: e?.payload || null });
  }
});

// POST /checkout/whatsapp
app.post("/checkout/whatsapp", requireApiKey, async (req, res) => {
  const { phone, text } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
  const url = `https://wa.me/${digitsOnly(phone)}?text=${encodeURIComponent(text || "Olá! 😊")}`;
  res.json({ ok: true, url });
});

// ======================================================
// 14) WEBHOOK META (WhatsApp)
// ======================================================
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
  // Meta quer 200 rápido
  res.sendStatus(200);

  try {
    const msgs = extractIncomingMessages(req.body);

    for (const msg of msgs) {
      const from = msg.from;
      const session = getSession(from);

      const textRaw = (msg.text || "").trim();
      const normalized = normalizeText(textRaw);

      const interactiveId = msg.interactive?.id || msg.interactive?.payload || null;
      const interactiveTitle = msg.interactive?.title || null;

      // ---------------------------
      // 0) Status por texto
      // ---------------------------
      const statusIdFromText = extractStatusOrderIdFromText(textRaw);
      if (statusIdFromText) {
        await handleStatusInquiry(from, statusIdFromText);
        continue;
      }

      // ---------------------------
      // 0.1) Se o cliente mandou LOCALIZAÇÃO (WhatsApp)
      // ---------------------------
      if (msg.type === "location" && msg.location) {
        const lat = Number(msg.location.latitude);
        const lng = Number(msg.location.longitude);

        await sendText(from, "📍 Recebi sua localização! Só um segundinho… vou confirmar o endereço no Google 🙏");

        const best = await googleReverseGeocode(lat, lng);
        if (!best) {
          session.step = "ASK_ADDRESS";
          await sendText(from, "Não consegui identificar o endereço 😕\nTenta enviar a localização novamente ou manda rua + número + bairro.");
          continue;
        }

        // Armazena como candidato único e pede confirmação
        session.addressCandidates = [best];
        session.step = "CONFIRM_ADDRESS";
        await sendText(from, `Encontrei este endereço:\n*${best.formatted}*\n\nConfirma pra mim? 🙂`);
        await sendButtons(from, "Está correto?", [
          { id: "ADDR_CONFIRM_0", title: "✅ Confirmar" },
          { id: "ADDR_RETRY", title: "✏️ Corrigir" },
          { id: "BACK_MENU", title: "⬅️ Menu" },
        ]);
        continue;
      }

      // ---------------------------
      // 1) Atalhos / reset / menu
      // ---------------------------
      if (
        normalized === "menu" ||
        normalized === "inicio" ||
        normalized === "início" ||
        normalized === "oi" ||
        normalized === "ola" ||
        normalized === "olá" ||
        interactiveId === "BACK_MENU"
      ) {
        resetSession(from);
        await sendText(from, "👋 Oi! Eu sou o atendimento da *Pappi Pizza* 🍕\nBora resolver rapidinho?");
        await showMainMenu(from);
        continue;
      }

      // ---------------------------
      // 2) Menu
      // ---------------------------
      if (interactiveId === "MENU_PEDIR") {
        session.step = "ASK_ORDER_TYPE";
        await askOrderType(from);
        continue;
      }

      if (interactiveId === "MENU_CARDAPIO") {
        await sendText(from, `📖 Cardápio online:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony`);
        await sendButtons(from, "Quer pedir por aqui comigo agora? 🙂", [
          { id: "MENU_PEDIR", title: "🛒 Fazer pedido" },
          { id: "BACK_MENU", title: "⬅️ Menu" },
        ]);
        continue;
      }

      if (interactiveId === "MENU_STATUS") {
        await sendText(from, "Me manda assim:\nstatus 7637462\n\nQue eu consulto no sistema 😉");
        continue;
      }

      // ---------------------------
      // 3) Tipo: entrega/retirada
      // ---------------------------
      if (interactiveId === "TYPE_DELIVERY") {
        session.fulfillment.type = "delivery";
        session.fulfillment.address_confirmed = false;
        session.fulfillment.google = null;
        session.fulfillment.quote = null;
        session.step = "ASK_ADDRESS";
        await askAddress(from);
        continue;
      }

      if (interactiveId === "TYPE_TAKEOUT") {
        session.fulfillment.type = "takeout";
        session.fulfillment.address = null;
        session.fulfillment.address_confirmed = true;
        session.fulfillment.google = null;
        session.fulfillment.quote = null;
        session.step = "SELECT_CATEGORY";
        await sendText(from, "Perfeito 🙂 Retirada na loja. Agora vamos escolher os itens!");
        await showCategories(from);
        continue;
      }

      // ---------------------------
      // 4) Endereço (OBRIGATÓRIO confirmar no Google)
      // ---------------------------
      if (session.step === "ASK_ADDRESS" && !interactiveId) {
        await sendText(from, "🔎 Só um segundinho… tô confirmando no Google pra não dar erro na entrega 🙏");
        const candidates = await googleGeocodeCandidates(textRaw);

        await confirmAddressFromCandidates(from, session, candidates);
        continue;
      }

      if (interactiveId && String(interactiveId).startsWith("ADDR_PICK_")) {
        const idx = Number(String(interactiveId).replace("ADDR_PICK_", ""));
        const chosen = session.addressCandidates?.[idx];
        if (!chosen) {
          await sendText(from, "Ops, perdi essa opção 😅 Manda o endereço de novo, por favor.");
          session.step = "ASK_ADDRESS";
          continue;
        }

        session.step = "CONFIRM_ADDRESS";
        await sendText(from, `Você escolheu:\n*${chosen.formatted}*\n\nConfirma? 🙂`);
        await sendButtons(from, "Está correto?", [
          { id: `ADDR_CONFIRM_${idx}`, title: "✅ Confirmar" },
          { id: "ADDR_RETRY", title: "✏️ Corrigir" },
        ]);
        continue;
      }

      if (interactiveId === "ADDR_RETRY") {
        session.step = "ASK_ADDRESS";
        session.fulfillment.address_confirmed = false;
        session.fulfillment.google = null;
        session.fulfillment.quote = null;
        await sendText(from, "Tranquilo 🙂 Manda o endereço de novo (rua, número e bairro) ou envie a localização.");
        continue;
      }

      if (interactiveId && String(interactiveId).startsWith("ADDR_CONFIRM_")) {
        const idx = Number(String(interactiveId).replace("ADDR_CONFIRM_", ""));
        const chosen = session.addressCandidates?.[idx];
        if (!chosen || !chosen.location) {
          await sendText(from, "Ops, não consegui confirmar 😕 Manda o endereço novamente, por favor.");
          session.step = "ASK_ADDRESS";
          continue;
        }

        // Salva endereço confirmado
        session.fulfillment.google = {
          formatted: chosen.formatted,
          location: chosen.location,
          placeId: chosen.placeId,
        };
        session.fulfillment.address_confirmed = true;

        // Faz quote (km/eta/frete)
        const quote = await mapsQuoteByLatLng(Number(chosen.location.lat), Number(chosen.location.lng));
        session.fulfillment.quote = quote.ok ? quote : null;

        if (quote.ok && !quote.is_serviceable) {
          // fora do raio
          session.step = "ASK_ADDRESS";
          session.fulfillment.address_confirmed = false;
          session.fulfillment.google = null;
          session.fulfillment.quote = null;
          await sendText(
            from,
            `😕 Esse endereço ficou *fora da nossa área de entrega*.\nSe quiser, você pode optar por *retirada* ou mandar outro endereço.`
          );
          await askOrderType(from);
          continue;
        }

        // Campos mínimos (o humano finaliza)
        const formatted = chosen.formatted || "";
        session.fulfillment.address = {
          street: null,
          number: null,
          neighborhood: null,
          city: DEFAULT_CITY,
          state: DEFAULT_STATE,
          zip: null,
          complement: null,
          reference: null,
        };
        const first = formatted.split(",")[0] || "";
        session.fulfillment.address.street = first.trim() || null;

        session.step = "SELECT_CATEGORY";

        const freteTxt =
          quote.ok && quote.is_serviceable
            ? `\n🛵 Frete: *R$${quote.delivery_fee}* | ${quote.km} km | ~${quote.eta_minutes} min`
            : "";

        await sendText(from, `✅ Endereço confirmado no Google!${freteTxt}\nAgora bora escolher o pedido 🍕`);
        await showCategories(from);
        continue;
      }

      // Se delivery e ainda não confirmou endereço, bloqueia qualquer avanço
      if (session.fulfillment?.type === "delivery" && session.fulfillment.address_confirmed === false) {
        if (session.step !== "ASK_ADDRESS" && session.step !== "PICK_ADDRESS" && session.step !== "CONFIRM_ADDRESS") {
          session.step = "ASK_ADDRESS";
          await sendText(from, "Antes de montar o pedido, preciso confirmar seu endereço no Google 🙏\nManda rua + número + bairro ou envie a localização.");
        }
      }

      // ---------------------------
      // 5) Catálogo: categorias / itens
      // ---------------------------
      if (interactiveId && String(interactiveId).startsWith("CAT_")) {
        const catId = String(interactiveId).replace("CAT_", "");
        session.step = "SELECT_ITEM";
        await showItemsFromCategory(from, catId);
        continue;
      }

      if (interactiveId && String(interactiveId).startsWith("ITEM_")) {
        const itemId = String(interactiveId).replace("ITEM_", "");
        session.draftItem = {
          item_id: Number(itemId),
          name: interactiveTitle || "Item selecionado",
          quantity: 1,
          notes: null,
          modifiers: [],
          option_groups: null,
          option_pick: {},
        };

        const catalog = await catalogGetSafe();
        const item =
          findItemByNameInCatalog(catalog, session.draftItem.name) ||
          (() => {
            for (const c of catalog.categories || []) {
              for (const it of c.items || []) if (String(it.id) === String(itemId)) return it;
            }
            return null;
          })();

        session.draftItem.option_groups = item?.option_groups || [];

        session.step = "ASK_ITEM_OBS";
        await askItemObservation(from, session.draftItem.name);
        continue;
      }

      // Observação: escolher sem obs ou escrever
      if (interactiveId === "OBS_NONE" && session.step === "ASK_ITEM_OBS") {
        session.draftItem.notes = null;

        const ogs = session.draftItem.option_groups || [];
        if (ogs.length > 0) {
          session.step = "PICK_OPTION_GROUP";
          session._ogIndex = 0;
          await showOptionGroupAsList(from, ogs[0], `OG_${ogs[0].id}`);
        } else {
          session.cart.push({ ...session.draftItem });
          session.draftItem = null;
          await sendText(from, "Perfeito! Adicionei no seu pedido ✅");
          await sendCartSummary(from, session);
          await upsellNudge(from);
        }
        continue;
      }

      if (interactiveId === "OBS_WRITE" && session.step === "ASK_ITEM_OBS") {
        session.step = "WAIT_ITEM_OBS_TEXT";
        await sendText(from, "Manda a observação aqui (ex: sem cebola / bem assada / cortar em 16).");
        continue;
      }

      if (session.step === "WAIT_ITEM_OBS_TEXT" && !interactiveId) {
        session.draftItem.notes = textRaw || null;

        const ogs = session.draftItem.option_groups || [];
        if (ogs.length > 0) {
          session.step = "PICK_OPTION_GROUP";
          session._ogIndex = 0;
          await showOptionGroupAsList(from, ogs[0], `OG_${ogs[0].id}`);
        } else {
          session.cart.push({ ...session.draftItem });
          session.draftItem = null;
          await sendText(from, "Show! Já anotei e coloquei no pedido ✅");
          await sendCartSummary(from, session);
          await upsellNudge(from);
        }
        continue;
      }

      // Opções (option groups)
      if (interactiveId && String(interactiveId).includes("_OPT_") && session.step === "PICK_OPTION_GROUP") {
        const parts = String(interactiveId).split("_OPT_");
        const left = parts[0];
        const optId = Number(parts[1]);
        const ogId = Number(left.replace("OG_", ""));

        const ogs = session.draftItem.option_groups || [];
        const og = ogs.find((x) => Number(x.id) === ogId);

        if (!og) {
          await sendText(from, "Ops, deu um erro nessa opção 😅 Vamos tentar de novo.");
          session._ogIndex = 0;
          if (ogs[0]) await showOptionGroupAsList(from, ogs[0], `OG_${ogs[0].id}`);
          continue;
        }

        const opt = (og.options || []).find((o) => Number(o.id) === optId);
        if (!opt) {
          await sendText(from, "Não achei essa opção 😕 Tenta escolher outra.");
          await showOptionGroupAsList(from, og, `OG_${og.id}`);
          continue;
        }

        session.draftItem.option_pick[String(ogId)] = optId;

        const nextIndex = Number(session._ogIndex || 0) + 1;
        if (nextIndex < ogs.length) {
          session._ogIndex = nextIndex;
          await showOptionGroupAsList(from, ogs[nextIndex], `OG_${ogs[nextIndex].id}`);
          continue;
        }

        session.cart.push({ ...session.draftItem });
        session.draftItem = null;
        session._ogIndex = 0;

        await sendText(from, "Fechado! Item adicionado no pedido ✅");
        await sendCartSummary(from, session);
        await upsellNudge(from);
        continue;
      }

      // Upsell: bebidas
      if (interactiveId === "UPSELL_DRINKS") {
        session.step = "SELECT_CATEGORY";
        const catalog = await catalogGetSafe();
        const bebidas = findCategoryByName(catalog, "bebida");
        if (bebidas) {
          await showItemsFromCategory(from, bebidas.id);
        } else {
          await sendText(from, "Me diz qual bebida você quer (ex: coca lata / guaraná 1L) 🙂");
        }
        continue;
      }

      if (interactiveId === "UPSELL_SKIP") {
        await askAnythingElse(from);
        continue;
      }

      // Mais itens?
      if (interactiveId === "ADD_MORE") {
        await showCategories(from);
        continue;
      }

      if (interactiveId === "ADD_NO") {
        await sendCartSummary(from, session);
        await sendButtons(from, "Só confirma pra mim: tá tudo certo assim? 🙂", [
          { id: "CONFIRM_FINISH", title: "✅ Confirmar" },
          { id: "ADD_MORE", title: "➕ Adicionar" },
          { id: "BACK_MENU", title: "⬅️ Menu" },
        ]);
        session.step = "CONFIRM_FINISH";
        continue;
      }

      if (interactiveId === "CONFIRM_FINISH" && session.step === "CONFIRM_FINISH") {
        await finalizeToHuman(from, session);
        continue;
      }

      // ---------------------------
      // 6) Fallback inteligente (texto livre)
      // ---------------------------
      if (normalized.includes("quero") || normalized.includes("pizza") || normalized.length >= 3) {
        if (session.step === "MENU") {
          await sendText(from, "Entendi 🙂 Vou te ajudar rapidinho.");
          await askOrderType(from);
          session.step = "ASK_ORDER_TYPE";
          continue;
        }

        if (["SELECT_CATEGORY", "SELECT_ITEM"].includes(session.step)) {
          const catalog = await catalogGetSafe();
          const item = findItemByNameInCatalog(catalog, textRaw);
          if (item) {
            session.draftItem = {
              item_id: Number(item.id),
              name: item.name,
              quantity: 1,
              notes: null,
              modifiers: [],
              option_groups: item.option_groups || [],
              option_pick: {},
            };
            session.step = "ASK_ITEM_OBS";
            await askItemObservation(from, session.draftItem.name);
            continue;
          }
        }
      }

      await sendText(from, "Beleza 🙂 Pra ficar fácil, escolhe uma opção aqui embaixo:");
      await showMainMenu(from);
    }
  } catch (err) {
    console.error("Webhook error:", err?.message, err?.payload || err);
  }
});

// ======================================================
// 15) WEBHOOK CARDÁPIO WEB (opcional)
// ======================================================
app.post("/cardapioweb/webhook", async (req, res) => {
  try {
    const token = req.header("X-Webhook-Token") || "";
    if (CARDAPIOWEB_WEBHOOK_TOKEN && token !== CARDAPIOWEB_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: "Invalid webhook token" });
    }

    res.status(200).json({ ok: true });

    const payload = req.body || {};
    const orderId = payload?.order_id || payload?.resource?.id || payload?.data?.id || payload?.id || null;
    if (!orderId) return;

    const phone = orderPhoneIndex.get(String(orderId));
    if (!phone) return;

    try {
      const order = await getOrderById(orderId);
      const st = mapOrderStatusPt(order?.status);
      await sendText(phone, `📦 Atualização do seu pedido *${orderId}*:\n*${st}*\n\nSe precisar de algo, me chama aqui 🙂`);
    } catch (e) {
      console.error("Webhook notify error:", e?.message, e?.payload || "");
    }
  } catch (e) {
    console.error("CardapioWeb webhook error:", e);
    return res.status(200).json({ ok: true });
  }
});

// ======================================================
// 16) START
// ======================================================
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));

