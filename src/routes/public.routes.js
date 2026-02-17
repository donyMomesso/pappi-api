const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const router = express.Router();
const prisma = new PrismaClient();

// Usando o nome estável que garante a conexão
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

// ===============================
// HELPERS (WHATSAPP)
// ===============================
async function sendText(to, text) {
    const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    await fetch(url, {
        method: "POST",
        headers: { 
            "Authorization": `Bearer ${ENV.WHATSAPP_TOKEN}`, 
            "Content-Type": "application/json" 
        },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            to: to,
            type: "text",
            text: { body: text }
        }),
    }).catch(e => console.error("❌ Erro WA API:", e));
}

// ===============================
// BUSCA CARDÁPIO (SIMPLES)
// ===============================
async function getMenu() {
    const url = "https://integracao.sandbox.cardapioweb.com/api/partner/v1/catalog";
    try {
        const resp = await fetch(url, { 
            headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, "Accept": "application/json" } 
        });
        const data = await resp.json();
        if (!data.categories) return "Cardápio disponível no balcão.";
        
        let txt = "🍕 *MENU PAPPI PIZZA:*\n";
        data.categories.forEach(cat => {
            if(cat.status === "ACTIVE") {
                txt += `\n*${cat.name.toUpperCase()}*\n`;
                cat.items.forEach(i => {
                    if(i.status === "ACTIVE") txt += `- ${i.name}: R$ ${i.price.toFixed(2)}\n`;
                });
            }
        });
        return txt;
    } catch (e) { return "Erro ao carregar cardápio."; }
}

// ===============================
// WEBHOOK PRINCIPAL
// ===============================
router.get("/webhook", (req, res) => {
    if (req.query["hub.verify_token"] === ENV.WEBHOOK_VERIFY_TOKEN) {
        return res.status(200).send(req.query["hub.challenge"]);
    }
    res.sendStatus(403);
});

router.post("/webhook", async (req, res) => {
    res.sendStatus(200);
    const body = req.body;
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || !msg.text) return; // Focado em texto como antes

    const from = msg.from;
    const text = msg.text.body;

    try {
        const menu = await getMenu();
        const configPix = await prisma.config.findUnique({ where: { key: "CHAVE_PIX" } });
        const pix = configPix?.value || "PIX: 19 9 8319 3999 (Inter) - Darclee Duran";

        const prompt = `Você é o atendente da Pappi Pizza (Campinas). 
        Menu: ${menu}
        Pagamento: ${pix}
        Regras: Seja breve, peça o endereço e sugira a Margherita.`;

        const result = await model.generateContent(`${prompt}\nCliente: ${text}\nAtendente:`);
        await sendText(from, result.response.text());

    } catch (error) {
        console.error("🔥 Erro:", error);
        await sendText(from, "Puxa, estamos com muitos pedidos! Tente de novo em 1 minuto. 🍕");
    }
});

module.exports = router;
