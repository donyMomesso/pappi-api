const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getCatalogText } = require("../services/catalog.service");

const router = express.Router();
const prisma = new PrismaClient();

// Inteligência Artificial - Modelo Gemini 3 Flash
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

const chatHistory = new Map();

// ===============================
// 1. ROTAS DE INFORMAÇÃO (OpenAPI)
// ===============================

router.get("/", (req, res) => res.send("Pappi Pizza API Online ✅"));

router.get("/health", (req, res) => res.json({ 
    ok: true, 
    app: "Pappi Pizza IA", 
    time: new Date().toISOString() 
}));

router.get("/meta", (req, res) => {
    res.json({
        ok: true,
        app: "Pappi Pizza",
        version: "1.2.0",
        env: {
            hasWhatsapp: !!process.env.WHATSAPP_TOKEN,
            hasCardapioWeb: !!process.env.CARDAPIOWEB_TOKEN,
            hasGoogleMaps: !!process.env.GOOGLE_MAPS_API_KEY
        }
    });
});

router.get("/debug-auth", (req, res) => {
    res.json({
        ok: true,
        hasAttendantKey: !!process.env.ATTENDANT_API_KEY,
        hasCardapioWebToken: !!process.env.CARDAPIOWEB_TOKEN
    });
});

// ===============================
// 2. O CÉREBRO DA IA (WhatsApp Webhook)
// ===============================

router.post("/webhook", async (req, res) => {
    res.sendStatus(200);
    const body = req.body;
    if (!body.entry?.[0]?.changes?.[0]?.value?.messages) return;

    const msg = body.entry[0].changes[0].value.messages[0];
    const from = msg.from;
    const text = msg.text?.body || "";

    try {
        // Busca Cliente e Contexto de Pedidos no Prisma
        let customer = await prisma.customer.findUnique({ 
            where: { phone: from },
            include: { orders: { orderBy: { createdAt: 'desc' }, take: 1 } }
        });

        if (!customer) customer = await prisma.customer.create({ data: { phone: from } });

        const menu = await getCatalogText();
        const pix = await prisma.config.findUnique({ where: { key: 'CHAVE_PIX' } });

        const statusContext = customer.orders?.length > 0 
            ? `Status do último pedido (#${customer.orders[0].displayId}): ${customer.orders[0].status}` 
            : "Nenhum pedido recente encontrado.";

        const PROMPT = `
Você é o atendente humanizado da Pappi Pizza (Campinas-SP).
CARDÁPIO: ${menu}
PAGAMENTO PIX: ${pix?.value}
STATUS ATUAL: ${statusContext}

REGRAS:
1. Chame o cliente pelo nome: ${customer.name || "desconhecido"}.
2. Se o cliente mandar um número de 4 dígitos, salve como o pedido dele.
3. Seja amigável e use emojis moderadamente. 🍕
`;

        if (!chatHistory.has(from)) chatHistory.set(from, []);
        const history = chatHistory.get(from);
        history.push(`Cliente: ${text}`);

        const result = await model.generateContent(`${PROMPT}\n\nHistórico:\n${history.join("\n")}\nAtendente:`);
        const resposta = result.response.text();

        // Rastreio Automático de Pedido (ex: #5371)
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

        // Aqui você chamaria a sua função de envio waSend(from, resposta)
        console.log(`[BOT] Resposta enviada para ${from}`);

    } catch (error) {
        console.error("🔥 Erro no Brain:", error);
    }
});

// Utilitário para sua chave de API
router.get("/modelos-disponiveis", async (req, res) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url);
    res.json(await response.json());
});

module.exports = router;
