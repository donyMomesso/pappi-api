const express = require("express");
const app = express();
app.use(express.json());

// CONFIGURAÇÕES FIXAS DA SUA LOJA
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN; 
const CARDAPIOWEB_STORE_ID = "5371"; // Extraído da sua imagem
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

const SESSIONS = new Map();

// FUNÇÃO PARA ENVIAR MENSAGENS COM BOTÕES
async function enviarZap(to, body, buttons = []) {
  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_ID}/messages`;
  let payload = { messaging_product: "whatsapp", to, type: "text", text: { body } };

  if (buttons.length > 0) {
    payload = {
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: {
        type: "button", body: { text: body },
        action: { buttons: buttons.map((b, i) => ({ type: "reply", reply: { id: `btn${i}`, title: b } })) }
      }
    };
  }
  await fetch(url, { 
    method: "POST", 
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, 
    body: JSON.stringify(payload) 
  });
}

// WEBHOOK PRINCIPAL
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;

  const phone = msg.from;
  const text = (msg.text?.body || msg.interactive?.button_reply?.title || "").trim();
  const t = text.toLowerCase();

  if (!SESSIONS.has(phone)) SESSIONS.set(phone, { step: "inicio" });
  const session = SESSIONS.get(phone);

  // 1. INÍCIO E ESCOLHA DE CANAL
  if (session.step === "inicio" || t === "oi") {
    session.step = "escolha_canal";
    return await enviarZap(phone, "Pappi Pizza! 🍕\nComo deseja seu pedido?", ["Entrega 🛵", "Retirada 🥡"]);
  }

  // 2. DEFINIR CANAL E PEDIR ITEM/ENDEREÇO
  if (session.step === "escolha_canal") {
    session.canal = t.includes("entrega") ? "delivery" : "takeaway";
    if (session.canal === "delivery") {
        session.step = "endereco";
        return await enviarZap(phone, "Digite seu endereço completo (Rua, nº e Bairro):");
    } else {
        session.step = "item";
        return await enviarZap(phone, "Beleza! Qual pizza você deseja? (Digite o nome)");
    }
  }

  // 3. CAPTURAR ENDEREÇO
  if (session.step === "endereco") {
      session.address = text;
      session.step = "item";
      return await enviarZap(phone, "Endereço salvo! Agora me diga qual pizza você deseja:");
  }

  // 4. ENVIAR PARA O CARDÁPIO WEB (DIRECIONAMENTO)
  if (session.step === "item") {
    try {
      const pedido = await fetch(`https://integracao.cardapioweb.com/orders`, {
        method: "POST",
        headers: { "X-API-KEY": CARDAPIOWEB_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
          store_id: CARDAPIOWEB_STORE_ID,
          customer: { name: "Cliente WhatsApp", phone: phone },
          delivery_type: session.canal,
          address: session.canal === "delivery" ? { street: session.address } : null,
          items: [{ product_id: text, quantity: 1 }],
          payment_method: "A combinar"
        })
      });

      if (pedido.ok) {
        await enviarZap(phone, "Pedido enviado com sucesso para a cozinha! ✅🍕");
        session.step = "inicio";
      } else {
        throw new Error();
      }
    } catch (e) {
      await enviarZap(phone, "Tive um problema ao enviar o pedido. Tente novamente em alguns minutos.");
    }
  }
});

app.get("/webhook", (req, res) => res.status(200).send(req.query["hub.challenge"]));
app.listen(process.env.PORT || 10000);
