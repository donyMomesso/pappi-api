const express = require("express");
const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN; 
const CARDAPIOWEB_STORE_ID = "5371"; // Seu ID confirmado

const SESSIONS = new Map();

async function enviarZap(to, text, buttons = []) {
  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_ID}/messages`;
  let payload = { messaging_product: "whatsapp", to, type: "text", text: { body: text } };

  if (buttons.length > 0) {
    payload = {
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: {
        type: "button", body: { text },
        action: { buttons: buttons.map((b, i) => ({ type: "reply", reply: { id: `id${i}`, title: b } })) }
      }
    };
  }
  await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const m = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!m) return;

  const phone = m.from;
  const rawText = (m.text?.body || m.interactive?.button_reply?.title || "").trim();
  const t = rawText.toLowerCase();

  if (!SESSIONS.has(phone)) SESSIONS.set(phone, { step: "inicio" });
  const session = SESSIONS.get(phone);

  // FLUXO DE DIRECIONAMENTO
  if (session.step === "inicio" || t === "oi") {
    session.step = "canal";
    return await enviarZap(phone, "Pappi Pizza! 🍕\nComo deseja seu pedido?", ["Entrega 🛵", "Retirada 🥡"]);
  }

  if (session.step === "canal") {
    session.tipo = t.includes("entrega") ? "delivery" : "takeaway";
    session.step = (session.tipo === "delivery") ? "endereco" : "item";
    const msg = (session.tipo === "delivery") ? "Digite seu endereço (Rua, nº, Bairro):" : "Qual pizza você deseja?";
    return await enviarZap(phone, msg);
  }

  if (session.step === "endereco") {
    session.endereco = rawText;
    session.step = "item";
    return await enviarZap(phone, "Endereço salvo! 📍 Agora digite o nome da pizza:");
  }

  if (session.step === "item") {
    // ENVIO DIRETO PARA O PAINEL
    const resPedido = await fetch(`https://integracao.cardapioweb.com/orders`, {
      method: "POST",
      headers: { "X-API-KEY": CARDAPIOWEB_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        store_id: CARDAPIOWEB_STORE_ID,
        customer: { name: "Cliente Whats", phone: phone },
        delivery_type: session.tipo,
        address: session.tipo === "delivery" ? { street: session.endereco } : null,
        items: [{ product_id: rawText, quantity: 1 }],
        payment_method: "A combinar"
      })
    });

    if (resPedido.ok) {
      await enviarZap(phone, "✅ Pedido enviado! Verifique no seu painel da Pappi Pizza.");
    } else {
      await enviarZap(phone, "❌ Erro técnico. Verifique se o item existe no Cardápio Web.");
    }
    session.step = "inicio";
  }
});

app.get("/webhook", (req, res) => res.status(200).send(req.query["hub.challenge"]));
app.listen(process.env.PORT || 10000);
