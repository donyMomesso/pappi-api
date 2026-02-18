const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getCatalogText } = require("../services/catalog.service");

const router = express.Router();
const prisma = new PrismaClient();

// Configuração para o modelo que funcionou na sua chave: Gemini 3 Flash
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

router.post("/webhook", async (req, res) => {
    res.sendStatus(200);
    const body = req.body;
    if (!body.entry?.[0]?.changes?.[0]?.value?.messages) return;

    const msg = body.entry[0].changes[0].value.messages[0];
    const from = msg.from;
    const text = msg.text?.body || "";

    try {
        // 1. Identifica cliente e busca último pedido no CardápioWeb
        let customer = await prisma.customer.findUnique({ where: { phone: from } });
        if (!customer) customer = await prisma.customer.create({ data: { phone: from } });

        const menu = await getCatalogText();
        const pix = await prisma.config.findUnique({ where: { key: 'CHAVE_PIX' } });

        // 2. Prompt com inteligência de vendas e status
        const PROMPT = `
        Você é o atendente da Pappi Pizza (Campinas).
        CARDÁPIO: ${menu}
        PIX: ${pix?.value}
        CLIENTE: ${customer.name || "Novo"}
        
        REGRAS: 
        - Se perguntarem do pedido, diga que você pode consultar pelo número.
        - Se for a primeira vez, peça o nome.
        - Seja caloroso e use emojis.
        `;

        const result = await model.generateContent(`${PROMPT}\n\nCliente: ${text}\nAtendente:`);
        const resposta = result.response.text();

        // Envio para o WhatsApp (usando sua função waSend ou similar)
        // Aqui deve-se usar a lógica de envio já configurada no seu ENV
        console.log(`Resposta para ${from}: ${resposta}`);

    } catch (error) {
        console.error("🔥 Erro Geral:", error);
    }
});

// Rota de debug que você criou
router.get("/modelos-disponiveis", async (req, res) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url);
    res.json(await response.json());
});

module.exports = router;
