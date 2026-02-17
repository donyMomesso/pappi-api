const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const router = express.Router();
const prisma = new PrismaClient();

// Inicializa a IA do Google com o modelo gratuito confirmado na sua conta
const apiKey = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ===============================
// 1. HELPERS E WHATSAPP ENGINE
// ===============================
function digitsOnly(str) { return String(str || "").replace(/\D/g, ""); }

async function waSend(payload) {
    if (!ENV.WHATSAPP_TOKEN || !ENV.WHATSAPP_PHONE_NUMBER_ID) return;
    const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${ENV.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).catch(e => console.error("❌ Erro WA API:", e));
}

async function sendText(to, text) { 
    return waSend({ messaging_product: "whatsapp", to: digitsOnly(to), type: "text", text: { body: text } }); 
}

// ===============================
// 2. MEMÓRIA DE CONVERSA (Curto Prazo)
// ===============================
const chatHistory = new Map();

// ===============================
// 3. ROTAS E WEBHOOK
// ===============================
router.get("/", (req, res) => res.send("Pappi API IA online 🧠✅"));

router.get("/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === ENV.WEBHOOK_VERIFY_TOKEN) {
        return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.sendStatus(403);
});

router.post("/webhook", async (req, res) => {
    res.sendStatus(200); 
    const body = req.body;
    if (!body.entry?.[0]?.changes?.[0]?.value?.messages) return;

    const msg = body.entry[0].changes[0].value.messages[0];
    const from = msg.from;
    const text = msg.text?.body || "";
    if (!text) return;

    try {
        // 1. BUSCA DADOS NO BANCO EM TEMPO REAL (Sabores e PIX)
        const configPix = await prisma.config.findUnique({ where: { key: "CHAVE_PIX" } });
        const saboresDb = await prisma.sabores.findMany({ where: { disponivel: true } });
        
        const pixTexto = configPix ? configPix.value : "pappi@pix.com (CNPJ)";
        const listaSabores = saboresDb.map(s => `- ${s.nome}: R$ ${s.preco} (${s.ingredientes || ""})`).join("\n");

        // 2. BUSCA OU CRIA O CLIENTE (Memória de longo prazo)
        let customer = await prisma.customer.findUnique({ where: { phone: from } });
        if (!customer) {
            customer = await prisma.customer.create({ data: { phone: from } });
        } else {
            await prisma.customer.update({ where: { phone: from }, data: { lastInteraction: new Date() } });
        }

        // 3. PREPARA O CÉREBRO DA IA COM AS REGRAS DO BANCO
        const PROMPT_DINAMICO = `
Você é o atendente da Pappi Pizza (Campinas-SP).
CLIENTE: ${customer.name || "Novo Cliente"} (${from})

SABORES DISPONÍVEIS (Use estes preços):
${listaSabores || "Consulte nosso atendente para os sabores do dia."}

FORMA DE PAGAMENTO (PIX):
${pixTexto}

REGRAS OBRIGATÓRIAS:
1. Sempre confirme Rua, Número e Bairro para entrega.
2. Sugira a Pizza Margherita como a favorita da casa.
3. Seja cordial e use emojis moderadamente.
`;

        // 4. HISTÓRICO DE CURTO PRAZO
        if (!chatHistory.has(from)) chatHistory.set(from, []);
        const history = chatHistory.get(from);
        history.push(`Cliente: ${text}`);
        if (history.length > 10) history.shift();

        // 5. GERA RESPOSTA COM GEMINI 2.5 FLASH
        const fullPrompt = `${PROMPT_DINAMICO}\n\nHistórico:\n${history.join("\n")}\n\nAtendente:`;
        const result = await model.generateContent(fullPrompt);
        const respostaBot = result.response.text();

        history.push(`Atendente: ${respostaBot}`);

        // 6. ENVIA PARA O WHATSAPP
        await sendText(from, respostaBot);

    } catch (error) {
        console.error("🔥 Erro na IA/Banco:", error);
        await sendText(from, "Puxa, tivemos um pequeno problema técnico. Pode repetir? 🍕");
    }
});

module.exports = router;
