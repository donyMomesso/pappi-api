const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getCatalogText } = require("../services/catalog.service");
const ENV = require("../config/env");

const router = express.Router();
const prisma = new PrismaClient();

const genAI = new GoogleGenerativeAI(ENV.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const chatHistory = new Map();

async function sendText(to, text) {
    if (!ENV.WHATSAPP_TOKEN || !ENV.WHATSAPP_PHONE_NUMBER_ID) return;
    const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    try {
        await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${ENV.WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                to: String(to),
                type: "text",
                text: { body: text }
            })
        });
    } catch (e) { console.error("Erro no envio:", e); }
}

router.get("/health", (req, res) => res.json({ ok: true, app: "Pappi Pizza IA" }));

router.post("/webhook", async (req, res) => {
    res.sendStatus(200);
    
    const body = req.body;
    if (!body.entry?.[0]?.changes?.[0]?.value?.messages) return;

    const msg = body.entry[0].changes[0].value.messages[0];
    const from = msg.from;
    const text = msg.text?.body || "";

    try {
        let customer = await prisma.customer.findUnique({ 
            where: { phone: from },
            include: { orders: { orderBy: { createdAt: 'desc' }, take: 1 } }
        });

        if (!customer) customer = await prisma.customer.create({ data: { phone: from } });

        const menu = await getCatalogText();
        const pix = await prisma.config.findUnique({ where: { key: 'CHAVE_PIX' } });

        const statusContext = customer.orders?.length > 0 
            ? `Status do último pedido (#${customer.orders[0].displayId}): ${customer.orders[0].status}` 
            : "Nenhum pedido recente.";

        const PROMPT = `
Você é o atendente humanizado da Pappi Pizza.
CARDÁPIO: ${menu}
PAGAMENTO PIX: ${pix?.value}
STATUS ATUAL DO CLIENTE: ${statusContext}

REGRAS:
1. Se o cliente perguntar de pedido, veja o STATUS ATUAL.
2. Seja amigável, rápido e vendedor. 🍕
`;

        if (!chatHistory.has(from)) chatHistory.set(from, []);
        const history = chatHistory.get(from);
        history.push(`Cliente: ${text}`);

        const result = await model.generateContent(`${PROMPT}\n\nHistórico:\n${history.join("\n")}\nAtendente:`);
        const resposta = result.response.text();

        const orderMatch = text.match(/#?(\d{4})/);
        if (orderMatch) {
            const displayId = orderMatch[1];
            await prisma.order.upsert({
                where: { displayId },
                update: { customerId: customer.id },
                create: { displayId, customerId: customer.id, total: 0, items: "Via Bot" }
            });
        }

        history.push(`Atendente: ${resposta}`);
        if (history.length > 10) history.shift();

        await sendText(from, resposta);
        console.log(`[BOT] Respondeu para ${from}`);

    } catch (error) {
        console.error("🔥 Erro no Brain:", error);
    }
});

module.exports = router;
