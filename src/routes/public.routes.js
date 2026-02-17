const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getCatalogText } = require("../services/catalog.service");
const { getOrderHistory } = require("../services/order.service");
const { downloadWhatsAppMedia } = require("../services/media.service");

const router = express.Router();
const prisma = new PrismaClient();

// Modelo estável para evitar erros de cota 429
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });


// Memória de histórico curta (opcional, já que usamos banco para longo prazo)
const chatHistory = new Map();

// Helper para envio de texto
async function sendText(to, text) {
    const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${ENV.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
    }).catch(e => console.error("❌ Erro WA API:", e));
}

router.post("/webhook", async (req, res) => {
    res.sendStatus(200);
    const body = req.body;
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;

    try {
        // 1. Identifica o tipo de entrada (Texto ou Áudio)
        let aiInput;
        if (msg.type === "text") {
            aiInput = msg.text.body;
        } else if (msg.type === "audio") {
            const audioBase64 = await downloadWhatsAppMedia(msg.audio.id);
            if (!audioBase64) return sendText(from, "Puxa, não consegui ouvir seu áudio. Pode repetir?");
            
            aiInput = [
                { inlineData: { data: audioBase64, mimeType: "audio/ogg" } },
                { text: "O cliente enviou um áudio. Transcreva-o internamente e responda como atendente da Pappi Pizza." }
            ];
        } else {
            return; // Ignora outros tipos de mídia por enquanto
        }

        // 2. Busca dados em tempo real (Cardápio, Histórico e PIX)
        const [menuOficial, history, customer, configPix] = await Promise.all([
            getCatalogText(),
            getOrderHistory(from),
            prisma.customer.upsert({
                where: { phone: from },
                update: { lastInteraction: new Date() },
                create: { phone: from }
            }),
            prisma.config.findUnique({ where: { key: "CHAVE_PIX" } })
        ]);

        const pixTexto = configPix?.value || "PIX: 19 9 8319 3999 (Inter) - Darclee Duran";

        // 3. Prompt do Sistema
        const PROMPT_SISTEMA = `
Você é o atendente humanizado da Pappi Pizza em Campinas.
Cliente: ${customer.name || "Dony"}

CARDÁPIO ATUALIZADO (Siga rigorosamente):
${menuOficial}

HISTÓRICO DO CLIENTE:
${history}

PAGAMENTO (PIX):
${pixTexto}

REGRAS:
1. Use apenas sabores do cardápio.
2. Peça Rua, Número e Bairro em Campinas.
3. Sugira a Margherita.
4. Se for áudio, responda em texto de forma clara.
`;

        // 4. Gera resposta com Gemini 1.5 Flash
        const contentToGenerate = typeof aiInput === 'string' 
            ? `${PROMPT_SISTEMA}\nCliente: ${aiInput}\nAtendente:` 
            : [PROMPT_SISTEMA, ...aiInput];

        const result = await model.generateContent(contentToGenerate);
        const respostaBot = result.response.text();

        // 5. Envia ao WhatsApp
        await sendText(from, respostaBot);

    } catch (error) {
        console.error("🔥 Erro no Webhook:", error);
        if (error.status === 429) {
            await sendText(from, "Estamos com muitos pedidos! Pode repetir em 1 minuto? 🍕");
        }
    }
});

module.exports = router;
