const express = require("express");
const app = express();
app.use(express.json());

// ===== DADOS REAIS EXTRAÍDOS DA SUA IMAGEM (f14035) =====
const WHATSAPP_TOKEN = "EAAmZCIKsCmUABQgZAzDK1CRpDTPdKFZB2x2RLDZAfJZCCtKi5V2ZAwzD8NVCU8D7ACCE7AmDvzqJQ0G7BoicEyEcOVPD4VribOh1zfVlk7CU27Cor6o9+oh26"; 
const WHATSAPP_PHONE_ID = "901776653029199"; 
const CARDAPIOWEB_TOKEN = "457DPYEpX32TcaxL2A7YcXiLUZwkY9jucKfL2WA5"; 
const CARDAPIOWEB_STORE_ID = "5371"; 
const VERIFY_TOKEN = "PAPPI_VERIFY_2026"; 

const SESSIONS = new Map();

// FUNÇÃO PARA ENVIAR MENSAGEM
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
  
  try {
    await fetch(url, { 
      method: "POST", 
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, 
      body: JSON.stringify(payload) 
    });
  } catch (e) { console.error("Erro ao enviar WhatsApp:", e); }
}

// WEBHOOK
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;

  const phone = msg.from;
  const text = (msg.text?.body || msg.interactive?.button_reply?.title || "").trim();
  const t = text.toLowerCase();

  if (!SESSIONS.has(phone)) SESSIONS.set(phone, { step: "inicio" });
  const session = SESSIONS.get(phone);

  // 1. INÍCIO
  if (session.step === "inicio" || t === "oi") {
    session.step = "escolha_canal";
    return await enviarZap(phone, "Pappi Pizza! 🍕\nComo deseja seu pedido?", ["Entrega 🛵", "Retirada 🥡"]);
  }

  // 2. CANAL E ENDEREÇO
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

  // 3. CAPTURA DE ENDEREÇO
  if (session.step === "endereco") {
    session.address = text;
    session.step = "item";
    return await enviarZap(phone, "Endereço salvo! 📍 Agora me diga qual pizza você deseja:");
  }

  // 4. ENVIO PARA O PAINEL DO CARDÁPIO WEB
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
        await enviarZap(phone, "✅ PEDIDO ENVIADO! Já estamos preparando sua pizza. 🍕");
        session.step = "inicio";
      } else {
        await enviarZap(phone, "❌ Tive um problema ao registrar seu pedido. Verifique se o nome da pizza está correto.");
      }
    } catch (e) {
      await enviarZap(phone, "❌ Erro de conexão com o painel.");
    }
  }
});

app.listen(process.env.PORT || 10000);
