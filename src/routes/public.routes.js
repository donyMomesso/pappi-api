const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getCatalogText } = require("../services/catalog.service");
const ENV = require("../config/env");

const router = express.Router();
const prisma = new PrismaClient();

// Inteligência Artificial - Modelo Gemini 1.5 Flash (mais rápido e estável)
const genAI = new GoogleGenerativeAI(ENV.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const chatHistory = new Map();

// ==========================================
// FUNÇÃO CRÍTICA: ENVIO PARA O WHATSAPP
// ==========================================
async function sendText(to, text) {
    if (!ENV.WHATSAPP_TOKEN || !ENV.WHATSAPP_PHONE_NUMBER_ID) {
        console.error("❌ ERRO: Faltam tokens do WhatsApp no arquivo de ambiente.");
        return;
    }
    
    const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    
    try {
        const response = await fetch(url, {
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
        
        if (!response.ok) {
            const errorData = await response.json();
            console.error("🔥 Erro na API do WhatsApp:", errorData);
        }
    } catch (e) {
        console.error("🔥 Falha ao tentar enviar mensagem para o WhatsApp:", e);
    }
}

// ==========================================
// 1. ROTAS DE INFORMAÇÃO (Painel / Status)
// ==========================================
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
            hasWhatsapp: !!ENV.WHATSAPP_TOKEN,
            hasCardapioWeb: !!ENV.CARDAPIOWEB_TOKEN,
            hasGoogleMaps: !!ENV.GOOGLE_MAPS_API_KEY
        }
    });
});

router.get("/debug-auth", (req, res) => {
    res.json({
        ok: true,
        hasAttendantKey: !!ENV.ATTENDANT_API_KEY,
        hasCardapioWebToken: !!ENV.CARDAPIOWEB_TOKEN
    });
});

// ==========================================
// 2. O CÉREBRO DA IA (WhatsApp Webhook)
// ==========================================
router.post("/webhook", async (req, res) => {
    // IMPORTANTE: Responder 200 rápido para o Meta (Facebook) não bloquear
    res.sendStatus(200);
    
    const body = req.body;
    if (!body.entry?.[0]?.changes?.[0]?.value?.messages) return;

    const msg = body.entry[0].changes[0].value.messages[0];
    const from = msg.from;
    const text = msg.text?.body || "";

    try {
        // Busca Cliente e Contexto de Pedidos no Banco de Dados
        let customer = await prisma.customer.findUnique({ 
            where: { phone: from },
            include: { orders: { orderBy: { createdAt: 'desc' }, take: 1 } }
        });

        if (!customer) {
            customer = await prisma.customer.create({ data: { phone: from } });
        }

        const menu = await getCatalogText();
        const pix = await prisma.config.findUnique({ where: { key: 'CHAVE_PIX' } });

        const statusContext = customer.orders?.length > 0 
            ? `Status do último pedido (#${customer.orders[0].displayId}): ${customer.orders[0].status}` 
            : "Nenhum pedido recente encontrado.";

        // Regras de Comportamento do Bot
        const PROMPT = `
Você é o atendente humanizado da Pappi Pizza (Campinas-SP).
CARDÁPIO: ${menu}
PAGAMENTO PIX: ${pix?.value}
STATUS ATUAL DO CLIENTE: ${statusContext}

REGRAS:
1. Chame o cliente pelo nome (se não souber, pergunte com educação).
2. Se o cliente perguntar do pedido ou status, baseie-se no "STATUS ATUAL" acima.
3. Seja amigável, rápido, vendedor e use emojis moderadamente. 🍕
`;

        if (!chatHistory.has(from)) chatHistory.set(from, []);
        const history = chatHistory.get(from);
        history.push(`Cliente: ${text}`);

        // O bot "pensa" na resposta
        const result = await model.generateContent(`${PROMPT}\n\nHistórico:\n${history.join("\n")}\nAtendente:`);
        const resposta = result.response.text();

        // Rastreio Automático de Pedido (ex: #5371) - Guarda no Banco
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

        // O bot "fala" com o cliente no WhatsApp
        await sendText(from, resposta);
        console.log(`[BOT] Resposta enviada para ${from}`);

    } catch (error) {
        console.error("🔥 Erro no Brain:", error);
        await sendText(from, "Desculpe, tive um probleminha técnico 😕. Tente novamente em alguns segundos!");
    }
});

module.exports = router;
