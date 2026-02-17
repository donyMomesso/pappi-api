const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getCatalogText } = require("../services/catalog.service"); // Importação modular
const { getOrderHistory } = require("../services/order.service");     // Importação modular

const router = express.Router();
const prisma = new PrismaClient();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const chatHistory = new Map();

// Helper para envio (Mantenha sua função waSend aqui)
async function sendText(to, text) { 
    const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${ENV.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
    });
}

router.post("/webhook", async (req, res) => {
    res.sendStatus(200);
    const body = req.body;
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const text = msg.text?.body || "";

    try {
        // Busca dados em paralelo para ganhar velocidade
        const [configPix, menu, history, customer] = await Promise.all([
            prisma.config.findUnique({ where: { key: "CHAVE_PIX" } }),
            getCatalogText(),
            getOrderHistory(from),
            prisma.customer.upsert({
                where: { phone: from },
                update: { lastInteraction: new Date() },
                create: { phone: from }
            })
        ]);

        const pixInfo = configPix?.value || "PIX: 19 9 8319 3999 (Inter) - Darclee Rodrigues";

        const PROMPT_FINAL = `
Você é o atendente humanizado da Pappi Pizza.
Cliente: ${customer.name || "Dony"}
Cidade: Campinas-SP

CARDÁPIO ATUALIZADO:
${menu}

HISTÓRICO DO CLIENTE:
${history}

PAGAMENTO (PIX):
${pixInfo}

INSTRUÇÕES:
- Use apenas os preços do cardápio.
- Peça endereço completo (Rua, Número, Bairro).
- Sugira a Margherita como a favorita.
`;

        const result = await model.generateContent(`${PROMPT_FINAL}\nCliente: ${text}\nAtendente:`);
        await sendText(from, result.response.text());

    } catch (error) {
        console.error("🔥 Erro:", error);
        await sendText(from, "Estamos com muitos pedidos! Tente novamente em um minuto. 🍕");
    }
});

module.exports = router;
