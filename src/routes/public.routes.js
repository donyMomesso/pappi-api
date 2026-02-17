const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getCatalogText } = require("../services/catalog.service"); // Importação do novo serviço

const router = express.Router();
const prisma = new PrismaClient();

// Usando modelo estável para evitar erro de cota 429
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

router.post("/webhook", async (req, res) => {
    res.sendStatus(200);
    const body = req.body;
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const text = msg.text?.body || "";

    try {
        // Busca o cardápio atualizado na hora da conversa
        const menuOficial = await getCatalogText();

        const PROMPT_SISTEMA = `
Você é o atendente da Pappi Pizza em Campinas.
CARDÁPIO REAL (Siga estes preços e sabores):
${menuOficial}

REGRAS DO CARDÁPIO:
1. Use APENAS os sabores listados acima.
2. Se o cliente pedir algo que não está no menu, explique educadamente que não temos no momento.
3. A Pizza Margherita é a nossa sugestão do dia.
`;

        const result = await model.generateContent(`${PROMPT_SISTEMA}\nCliente: ${text}\nAtendente:`);
        
        // Aqui você usaria sua função waSend para enviar a resposta ao cliente
        console.log("Resposta da IA:", result.response.text());

    } catch (error) {
        console.error("🔥 Erro no fluxo do cardápio:", error);
    }
});

module.exports = router;
