/**
 * Pappi Pizza API PRO
 * WhatsApp Cloud API (Interactive Buttons) + Cardápio Web Catalog + State machine
 * Node 18+ (fetch nativo)
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

// ===== STATE (memória por telefone) =====
/**
 * USER_STATE.get(phone) => {
 *   step: "menu" | "awaiting_delivery_address" | "awaiting_order_text" | "browsing_categories" | "browsing_items",
 *   orderType: "delivery" | "takeout" | null,
 *   addressText: string | null,
 *   selectedCategoryId: number | null
 * }
 */
const USER_STATE = new Map();

// Cache simples do catálogo (evita chamar a API toda hora)
let CATALOG_CACHE = null;
let CATALOG_CACHE_AT = 0;
const CATALOG_TTL_MS = 60 * 1000; // 60s

function nowIso() {
  return new Date().toISOString();
}

function ensureState(phone) {
  if (!USER_STATE.has(phone)) {
    USER_STATE.set(phone, {
      step: "menu",
      orderType: null,
      addressText: null,
      selectedCategoryId: null,
    });
  }
  return USER_STATE.get(phone);
}

function requireApiKey(req, res, next) {
  const key = req.header("X-API-Key");
  if (!API_KEY) {
    return res.status(500).json({
      error: "ServerMisconfigured",
      message:
        "ATTENDANT_API_KEY não configurada (Render > Environment Variables).",
    });
  }
  if (!key || key !== API_KEY) {
    return res
      .status(401)
      .json({ error: "Unauthorized", message: "API Key inválida ou ausente" });
  }
  next();
}

// ===== BASIC ROUTES =====
app.get("/", (req, res) => res.status(200).send("Pappi API online ✅"));

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, app: "API da Pappi Pizza", time: nowIso() });
});

app.get("/debug-auth", (req, res) => {
  const headerKey = req.header("X-API-Key") || "";
  res.status(200).json({
    ok: true,
    hasEnvAttendantKey: Boolean(process.env.ATTENDANT_API_KEY),
    attendantKeyLength: (process.env.ATTENDANT_API_KEY || "").length,
    hasHeaderKey: Boolean(headerKey),
    headerKeyLength: headerKey.length,
    hasWhatsappToken: Boolean(WHATSAPP_TOKEN),
    hasWhatsappPhoneNumberId: Boolean(WHATSAPP_PHONE_NUMBER_ID),
    hasWebhookVerifyToken: Boolean(WEBHOOK_VERIFY_TOKEN),
    cardapioWebBaseUrl: CARDAPIOWEB_BASE_URL,
    hasCardapioWebToken: Boolean(CARDAPIOWEB_TOKEN),
  });
});

// ===== CARDAPIO WEB =====
async function cardapioWebFetch(path, { method = "GET", body } = {}) {
  if (!CARDAPIOWEB_TOKEN) throw new Error("CARDAPIOWEB_TOKEN não configurado.");

  const url = `${CARDAPIOWEB_BASE_URL}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "X-API-KEY": CARDAPIOWEB_TOKEN, // padrão Cardápio Web
      "Content-Type": "application/json",
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
    const msg = data?.message || data?.error || text || `Erro ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }

  return data;
}

async function getCatalogCached() {
  const now = Date.now();
  if (CATALOG_CACHE && now - CATALOG_CACHE_AT < CATALOG_TTL_MS) return CATALOG_CACHE;

  // Endpoint que você mostrou:
  // GET /api/partner/v1/catalog
  const catalog = await cardapioWebFetch("/api/partner/v1/catalog");
  CATALOG_CACHE = catalog;
  CATALOG_CACHE_AT = now;
  return catalog;
}

function findCategory(catalog, categoryId) {
  return (catalog?.categories || []).find((c) => String(c.id) === String(categoryId));
}

// ===== WHATSAPP SENDERS =====
async function waSend(payload) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurados.");
  }

  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || `Erro WhatsApp (${resp.status})`;
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
    to: String(to).replace(/\D/g, ""),
    type: "text",
    text: { body: text },
  });
}

async function sendButtons(to, bodyText, buttons) {
  // WhatsApp permite até 3 botões
  const safeButtons = buttons.slice(0, 3).map((b, idx) => ({
    type: "reply",
    reply: { id: b.id || `btn_${idx}`, title: b.title.slice(0, 20) },
  }));

  return waSend({
    messaging_product: "whatsapp",
    to: String(to).replace(/\D/g, ""),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: { buttons: safeButtons },
    },
  });
}

// ===== WEBHOOK (Meta) =====

// 1) Verificação (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Util: extrair texto e botões
function extractIncoming(body) {
  const entry = body?.entry || [];
  const out = [];

  for (const e of entry) {
    for (const ch of e?.changes || []) {
      const value = ch?.value;
      const messages = value?.messages || [];

      for (const m of messages) {
        const from = m.from;
        const type = m.type;

        // Texto normal
        if (type === "text") {
          out.push({ from, kind: "text", text: m.text?.body || "" });
        }

        // Botão clicado
        if (type === "interactive") {
          const btnId = m.interactive?.button_reply?.id || "";
          const btnTitle = m.interactive?.button_reply?.title || "";
          out.push({ from, kind: "button", id: btnId, title: btnTitle });
        }
      }
    }
  }
  return out;
}

// Menu principal
async function showMainMenu(to) {
  await sendButtons(to, "Olá! 👋 Sou a atendente automática da *Pappi Pizza* 🍕\nO que você quer fazer?", [
    { id: "menu_catalogo", title: "📖 Cardápio" },
    { id: "menu_pedido", title: "🛒 Fazer pedido" },
    { id: "menu_atendente", title: "👨‍🍳 Atendente" },
  ]);
}

// Fluxo: Cardápio -> categorias
async function showCategories(to) {
  const catalog = await getCatalogCached();
  const categories = (catalog?.categories || [])
    .filter((c) => c.status === "ACTIVE");

  // mostra 3 categorias por vez (limite de botões)
  const top = categories.slice(0, 3);
  if (top.length === 0) {
    await sendText(to, "Não encontrei categorias ativas no catálogo agora.");
    return;
  }

  await sendButtons(to, "Escolha uma categoria 👇", top.map((c) => ({
    id: `cat_${c.id}`,
    title: c.name,
  })));

  // dica de mais categorias
  if (categories.length > 3) {
    await sendText(to, "Se quiser outra categoria, me diga o nome dela (ex: *Bebidas*, *Pizzas*).");
  }
}

// Fluxo: categoria -> itens
async function showItemsFromCategory(to, categoryId) {
  const catalog = await getCatalogCached();
  const cat = findCategory(catalog, categoryId);

  if (!cat) {
    await sendText(to, "Não achei essa categoria. Mande *cardápio* pra ver novamente.");
    return;
  }

  const items = (cat.items || []).filter((i) => i.status === "ACTIVE");
  if (items.length === 0) {
    await sendText(to, `A categoria *${cat.name}* está sem itens ativos.`);
    return;
  }

  const topItems = items.slice(0, 3);
  const textList = topItems
    .map((it, idx) => {
      const base = `(${idx + 1}) ${it.name}`;
      const price = it.price != null ? ` — R$ ${Number(it.price).toFixed(2)}` : "";
      return base + price;
    })
    .join("\n");

  // Botões: escolher 1, 2, 3
  await sendButtons(
    to,
    `*${cat.name}*\nEscolha um item:\n${textList}`,
    topItems.map((it) => ({
      id: `item_${it.id}`,
      title: it.name,
    }))
  );

  if (items.length > 3) {
    await sendText(to, "Se não aparecer, me diga o nome do item que você quer.");
  }
}

// ===== WEBHOOK RECEIVER (POST) =====
app.post("/webhook", async (req, res) => {
  // responde rápido para a Meta
  res.sendStatus(200);

  try {
    const incoming = extractIncoming(req.body);

    for (const ev of incoming) {
      const phone = ev.from;
      const state = ensureState(phone);

      // Normaliza entrada para texto
      const rawText =
        ev.kind === "text"
          ? (ev.text || "").trim()
          : (ev.title || "").trim();

      const lower = rawText.toLowerCase();

      // ===== COMMANDS GLOBAIS =====
      if (!rawText || lower === "oi" || lower === "olá" || lower === "ola" || lower === "menu") {
        state.step = "menu";
        state.orderType = null;
        state.addressText = null;
        state.selectedCategoryId = null;
        await showMainMenu(phone);
        continue;
      }

      if (lower === "cardapio" || lower === "cardápio") {
        state.step = "browsing_categories";
        await showCategories(phone);
        continue;
      }

      // ===== CLIQUE NO MENU PRINCIPAL =====
      if (ev.kind === "button" && ev.id === "menu_catalogo") {
        state.step = "browsing_categories";
        await showCategories(phone);
        continue;
      }

      if (ev.kind === "button" && ev.id === "menu_pedido") {
        // pergunta entrega/retirada com botões
        state.step = "choose_order_type";
        await sendButtons(phone, "Perfeito! É *entrega* ou *retirada*?", [
          { id: "tipo_entrega", title: "🛵 Entrega" },
          { id: "tipo_retirada", title: "🏃 Retirada" },
        ]);
        continue;
      }

      if (ev.kind === "button" && ev.id === "menu_atendente") {
        state.step = "menu";
        await sendText(phone, "👨‍🍳 Certo! Um atendente vai te chamar já já.\nEnquanto isso, você pode ver o cardápio: https://app.cardapioweb.com/pappi_pizza?s=dony");
        continue;
      }

      // ===== ENTREGA / RETIRADA =====
      if (ev.kind === "button" && ev.id === "tipo_entrega") {
        state.orderType = "delivery";
        state.step = "awaiting_delivery_address";
        await sendText(phone, "🛵 *Entrega*\nMe mande:\n1) Rua e nº\n2) Bairro\n3) Referência");
        continue;
      }

      if (ev.kind === "button" && ev.id === "tipo_retirada") {
        state.orderType = "takeout";
        state.step = "awaiting_order_text";
        await sendText(phone, "🏃‍♂️ *Retirada*\nMe diga seu pedido (ex: *1 Calabresa grande + 1 Coca 2L*).");
        continue;
      }

      // ===== CATÁLOGO: CATEGORIA SELECIONADA =====
      if (ev.kind === "button" && ev.id.startsWith("cat_")) {
        const categoryId = ev.id.replace("cat_", "");
        state.selectedCategoryId = Number(categoryId);
        state.step = "browsing_items";
        await showItemsFromCategory(phone, categoryId);
        continue;
      }

      // ===== CATÁLOGO: ITEM SELECIONADO =====
      if (ev.kind === "button" && ev.id.startsWith("item_")) {
        const itemId = ev.id.replace("item_", "");
        state.step = "awaiting_order_text";
        await sendText(
          phone,
          `✅ Perfeito! Você escolheu o item ID *${itemId}*.\nAgora me diga:\n- Tamanho (se tiver)\n- Observações\nEx: *Grande, sem cebola*`
        );
        continue;
      }

      // ===== SE ESTÁ ESPERANDO ENDEREÇO =====
      if (state.step === "awaiting_delivery_address") {
        state.addressText = rawText;
        state.step = "awaiting_order_text";
        await sendText(phone, "📍 Endereço recebido ✅\nAgora me diga seu pedido (ex: *1 Calabresa grande + 1 Coca 2L*).");
        continue;
      }

      // ===== SE ESTÁ ESPERANDO PEDIDO =====
      if (state.step === "awaiting_order_text") {
        state.step = "menu";

        const resumo =
          `🧾 *Resumo do pedido*\n` +
          `Tipo: *${state.orderType === "delivery" ? "Entrega" : "Retirada"}*\n` +
          (state.orderType === "delivery" && state.addressText ? `Endereço: ${state.addressText}\n` : "") +
          `Pedido: ${rawText}\n\n` +
          `✅ Se estiver certo, responda: *CONFIRMAR*\n` +
          `❌ Para corrigir, responda: *ALTERAR*`;

        // guarda o texto pra confirmar
        state.lastOrderText = rawText;
        state.step = "awaiting_confirm";
        await sendText(phone, resumo);
        continue;
      }

      // ===== CONFIRMAÇÃO =====
      if (state.step === "awaiting_confirm") {
        if (lower.includes("confirmar")) {
          // Aqui você pode: criar pedido no seu sistema / chamar Cardápio Web "Pedidos via API" (quando for habilitar)
          state.step = "menu";
          await sendText(phone, "🔥 Pedido confirmado! Vou encaminhar para produção.\nSe precisar de mais algo, digite *menu*.");
          continue;
        }

        if (lower.includes("alterar")) {
          state.step = "awaiting_order_text";
          await sendText(phone, "Sem problema 🙂\nMe diga novamente o pedido (ex: *1 Calabresa grande + 1 Coca 2L*).");
          continue;
        }

        await sendText(phone, "Responda *CONFIRMAR* ou *ALTERAR* 🙂");
        continue;
      }

      // ===== FALLBACK =====
      await showMainMenu(phone);
    }
  } catch (err) {
    console.error("Webhook error:", err?.message, err?.payload || "");
  }
});

// ===== PROTECTED INTERNAL (opcional) =====
app.get("/internal/ping", requireApiKey, (req, res) => {
  res.json({ ok: true, time: nowIso() });
});

// ===== RUN =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi Pizza API rodando na porta", PORT));
