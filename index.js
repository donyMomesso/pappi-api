const express = require("express");
const app = express();
app.use(express.json());

// CONFIGURAÇÕES EXTRAÍDAS DAS SUAS IMAGENS
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN; 
const CARDAPIOWEB_STORE_ID = "5371"; // Seu código da loja

const SESSIONS = new Map();

// FUNÇÃO PARA ENVIAR MENSAGEM COM BOTÕES
async function enviarZap(to, texto, botoes = []) {
  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_ID}/messages`;
  let corpo = { messaging_product: "whatsapp", to, type: "text", text: { body: texto } };

  if (botoes.length > 0) {
    corpo = {
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: {
        type: "button", body: { text: texto },
        action: { buttons: botoes.map((b, i) => ({ type: "reply", reply: { id: `id${i}`, title: b } })) }
      }
    };
  }
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(corpo)
  });
}

// WEBHOOK PARA RECEBER MENSAGENS
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const m = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!m) return;

  const fone = m.from;
  const msgCliente = (m.text?.body || m.interactive?.button_reply?.title || "").toLowerCase();
  
  if (!SESSIONS.has(fone)) SESSIONS.set(fone, { passo: "inicio" });
  const sessao = SESSIONS.get(fone);

  // ETAPA 1: SAUDAÇÃO
  if (sessao.passo === "inicio" || msgCliente === "oi") {
    sessao.passo = "canal";
    return await enviarZap(fone, "Pappi Pizza! 🍕\nComo deseja seu pedido?", ["Entrega 🛵", "Retirada 🥡"]);
  }

  // ETAPA 2: DEFINIR ENTREGA/RETIRADA E PEDIR ITEM
  if (sessao.passo === "canal") {
    sessao.tipo = msgCliente.includes("entrega") ? "delivery" : "takeaway";
    sessao.passo = "finalizar";
    return await enviarZap(fone, "Ótimo! Agora digite o nome da Pizza que deseja (Ex: Calabresa):");
  }

  // ETAPA 3: ENVIAR PARA O CARDÁPIO WEB
  if
