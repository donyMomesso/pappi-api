/**
 * Pappi API - WhatsApp Cloud + Cardápio Web (catálogo) + Botões
 * Node 18+ (fetch nativo)
 *
 * ✅ O que este index já faz:
 * - /health e /debug-auth
 * - Webhook GET/POST da Meta
 * - Botões (reply buttons) e lista (list message)
 * - Fluxo básico: Menu -> Cardápio / Fazer pedido / Atendente
 * - Fazer pedido -> Entrega/Retirada -> Endereço -> Tamanho -> Sabores (puxa do Catálogo Cardápio Web)
 *
 * ⚠️ Observação:
 * - Botões aceitam até 3 por mensagem (limite do WhatsApp).
 * - Lista é melhor para muitos sabores/categorias.
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
const CARDAPIOWEB_STORE_ID = process.env.CARDAPIOWEB_STORE_ID || ""; // opcional (se a API exigir)

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

// ===== HEALTH / DEBUG =====
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
    hasCardapioWebStoreId: Boolean(CARDAPIOWEB_STORE_ID),
  });
});

// ===== In-memory session (simples) =====
/**
 * sessions.get(phone) = {
 *   step: "MENU" | "ASK_ORDER_TYPE" | "ASK_ADDRESS" | "ASK_SIZE" | "ASK_FLAVOR" | "CONFIRM",
 *   orderType: "delivery" | "takeout",
 *   addressText: string,
 *   size: "BROTINHO_4" | "GRANDE_8" | "GIGANTE_16",
 *   flavorItemId: number | null,
 *   flavorName: string | null,
 * }
 */
const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) sessions.set(from, { step: "MENU" });
  return sessions.get(from);
}

function resetSession(from) {
  sessions.set(from, { step: "MENU" });
  return sessions.get(from);
}

// ===== Cardápio Web (helper) =====
async function cardapioWebFetch(path, { method = "GET", body } = {}) {
  if (!CARDAPIOWEB_TOKEN) {
    throw new Error("CARDAPIOWEB_TOKEN não configurado no Render (Environment).");
  }

  const url = `${CARDAPIOWEB_BASE_URL}${path}`;
  const headers = {
    "X-API-KEY": CARDAPIOWEB_TOKEN,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // algumas integrações exigem store_id em header (depende da sua conta/doc)
  if (CARDAPIOWEB_STORE_ID) headers["X-STORE-ID"] = String(CARDAPIOWEB_STORE_ID);

  const resp = await fetch(url, {
    method,
    headers,
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
    const msg = data?.message || data?.error || text || "Erro Cardápio Web";
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

// ✅ endpoint que você mostrou (produção):
// GET /api/partner/v1/catalog
async function getCatalog() {
  // se sua rota for outra, ajuste aqui:
  return cardapioWebFetch(`/api/partner/v1/catalog`);
}

// Monta lista de pizzas por categoria (primeira categoria com "pizza")
async function getPizzaCategoryFromCatalog() {
  const catalog = await getCatalog();
  const categories = catalog?.categories || [];
  const pizzaCat =
    categories.find((c) => normalizeText(c?.name).includes("pizza")) ||
    categories[0];

  const items = (pizzaCat?.items || []).filter((it) => it?.status === "ACTIVE");
  return { pizzaCategory: pizzaCat, items };
}

// ===== WhatsApp Cloud (helpers) =====
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
    const msg =
      data?.error?.message || data?.message || `Erro WhatsApp (${resp.status})`;
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

// ✅ Reply Buttons (máx 3)
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
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

// ✅ Lista (bom pra muitos sabores)
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
            description: r.description ? String(r.description).slice(0, 72) : undefined,
          })),
        })),
      },
    },
  });
}

// Extrai mensagens do webhook
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
          interactive:
            m.interactive?.button_reply ||
            m.interactive?.list_reply ||
            null,
          raw: m,
        });
      }
    }
  }
  return out;
}

// ===== MENUS =====
async function showMainMenu(to) {
  await sendButtons(to, "🍕 Pappi Pizza\nComo posso te ajudar?", [
    { id: "MENU_CARDAPIO", title: "📖 Cardápio" },
    { id: "MENU_PEDIDO", title: "🛒 Fazer pedido" },
    { id: "MENU_ATENDENTE", title: "👨‍🍳 Atendente" },
  ]);
}

async function askOrderType(to) {
  await sendButtons(to, "Perfeito! É entrega ou retirada?", [
    { id: "TYPE_DELIVERY", title: "🛵 Entrega" },
    { id: "TYPE_TAKEOUT", title: "🏃 Retirada" },
    { id: "BACK_MENU", title: "⬅️ Menu" },
  ]);
}

async function askAddress(to) {
  await sendText(
    to,
    "🛵 *Entrega*\nMe mande:\n1) Rua e nº\n2) Bairro\n3) Referência (opcional)\n\nEx: Rua X, 123 - Jardim Bandeira II"
  );
}

async function askSize(to) {
  await sendButtons(to, "Show! Agora escolha o tamanho:", [
    { id: "SIZE_BROTINHO_4", title: "🍕 Brotinho (4)" },
    { id: "SIZE_GRANDE_8", title: "🍕 Grande (8)" },
    { id: "SIZE_GIGANTE_16", title: "🍕 Gigante (16)" },
  ]);
}

async function showFlavorsList(to) {
  const { pizzaCategory, items } = await getPizzaCategoryFromCatalog();

  // 10 por seção (limite). Se tiver mais, corta (depois a gente pagina).
  const rows = items.slice(0, 10).map((it) => ({
    id: `FLAVOR_${it.id}`,
    title: it.name,
    description: it.description ? it.description.slice(0, 60) : " ",
  }));

  await sendList(
    to,
    `🍕 Escolha o sabor (${pizzaCategory?.name || "Pizzas"})`,
    "Ver sabores",
    [{ title: "Sabores", rows }]
  );
}

async function showOrderSummary(to, session) {
  const tipo = session.orderType === "delivery" ? "Entrega" : "Retirada";
  const tamanho =
    session.size === "BROTINHO_4"
      ? "Brotinho (4)"
      : session.size === "GRANDE_8"
      ? "Grande (8)"
      : "Gigante (16)";

  const resumo =
    `🧾 *Resumo do pedido*\n` +
    `Tipo: *${tipo}*\n` +
    (session.orderType === "delivery"
      ? `Endereço: *${session.addressText || "—"}*\n`
      : "") +
    `Tamanho: *${tamanho}*\n` +
    `Sabor: *${session.flavorName || "—"}*\n\n` +
    `✅ Se estiver certo, responda: *CONFIRMAR*\n` +
    `❌ Para corrigir, responda: *ALTERAR*`;

  await sendText(to, resumo);
}

// ===== WEBHOOK META =====
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
    const msgs = extractIncomingMessages(req.body);

    for (const msg of msgs) {
      const from = msg.from;

      // texto ou clique em botão/lista
      const text = (msg.text || "").trim();
      const interactiveId =
        msg.interactive?.id || msg.interactive?.payload || null; // payload no list_reply pode variar
      const interactiveTitle = msg.interactive?.title || null;

      const session = getSession(from);

      // ====== comandos universais ======
      const normalized = normalizeText(text);

      // reset
      if (normalized === "menu" || normalized === "inicio" || interactiveId === "BACK_MENU") {
        resetSession(from);
        await showMainMenu(from);
        continue;
      }

      // ====== clique nos botões do menu ======
      if (interactiveId === "MENU_CARDAPIO") {
        session.step = "MENU";
        await sendText(
          from,
          `📖 Cardápio online:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony\n\nQuer pedir por aqui? Clique em *Fazer pedido* 😉`
        );
        await showMainMenu(from);
        continue;
      }

      if (interactiveId === "MENU_PEDIDO") {
        session.step = "ASK_ORDER_TYPE";
        await askOrderType(from);
        continue;
      }

      if (interactiveId === "MENU_ATENDENTE") {
        session.step = "MENU";
        await sendText(from, "👨‍🍳 Já te chamo um atendente! Enquanto isso, quer ver o *cardápio*?");
        await showMainMenu(from);
        continue;
      }

      // ====== tipo (entrega/retirada) ======
      if (interactiveId === "TYPE_DELIVERY") {
        session.orderType = "delivery";
        session.step = "ASK_ADDRESS";
        await askAddress(from);
        continue;
      }

      if (interactiveId === "TYPE_TAKEOUT") {
        session.orderType = "takeout";
        session.addressText = "";
        session.step = "ASK_SIZE";
        await askSize(from);
        continue;
      }

      // ====== endereço (texto livre) ======
      if (session.step === "ASK_ADDRESS") {
        // salva endereço como texto por enquanto
        session.addressText = text || "";
        session.step = "ASK_SIZE";
        await sendText(from, "📍 Endereço recebido ✅");
        await askSize(from);
        continue;
      }

      // ====== tamanho ======
      if (
        interactiveId === "SIZE_BROTINHO_4" ||
        interactiveId === "SIZE_GRANDE_8" ||
        interactiveId === "SIZE_GIGANTE_16"
      ) {
        session.size =
          interactiveId === "SIZE_BROTINHO_4"
            ? "BROTINHO_4"
            : interactiveId === "SIZE_GRANDE_8"
            ? "GRANDE_8"
            : "GIGANTE_16";

        session.step = "ASK_FLAVOR";

        // puxa sabores do catálogo e mostra lista
        try {
          await showFlavorsList(from);
        } catch (e) {
          console.error("Catalog error:", e?.message, e?.payload || "");
          await sendText(
            from,
            "Não consegui puxar os sabores agora 😕\nMas você pode escolher pelo link:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony"
          );
        }
        continue;
      }

      // ====== seleção de sabor (LIST) ======
      if (interactiveId && String(interactiveId).startsWith("FLAVOR_")) {
        const itemId = Number(String(interactiveId).replace("FLAVOR_", ""));
        session.flavorItemId = Number.isFinite(itemId) ? itemId : null;
        session.flavorName = interactiveTitle || "Sabor selecionado";
        session.step = "CONFIRM";

        await showOrderSummary(from, session);
        continue;
      }

      // ====== confirmação ======
      if (normalizeText(text) === "confirmar" && session.step === "CONFIRM") {
        // Aqui você pode: criar pedido no Cardápio Web (se existir endpoint) ou mandar para humano
        await sendText(
          from,
          "✅ Perfeito! Pedido confirmado.\nJá vamos preparar e te chamar para finalizar o pagamento/entrega."
        );
        resetSession(from);
        await showMainMenu(from);
        continue;
      }

      if (normalizeText(text) === "alterar" && session.step === "CONFIRM") {
        session.step = "ASK_ORDER_TYPE";
        session.orderType = null;
        session.addressText = "";
        session.size = null;
        session.flavorItemId = null;
        session.flavorName = null;
        await sendText(from, "Sem problema 🙂 Vamos refazer rapidinho.");
        await askOrderType(from);
        continue;
      }

      // ====== fallback inteligente ======
      // se o usuário digitar "cardapio"
      if (normalized === "cardapio" || normalized === "cardápio") {
        await sendText(
          from,
          `📖 Cardápio online:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony\n\nQuer pedir por aqui? Clique em *Fazer pedido* 😉`
        );
        await showMainMenu(from);
        continue;
      }

      // se chegou aqui e não entendeu, mostra menu
      if (!text && !interactiveId) continue;

      // mantém “conversa humana” e guia pra botões
      await sendText(
        from,
        "Entendi 🙂\nPra ficar fácil e rápido, escolhe uma opção aqui embaixo:"
      );
      await showMainMenu(from);
    }
  } catch (err) {
    console.error("Webhook error:", err?.message, err?.payload || err);
  }
});

// ===== Run =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🔥 Pappi Pizza API rodando na porta", PORT));

