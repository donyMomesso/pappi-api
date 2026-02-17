const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const router = express.Router();
const prisma = new PrismaClient();

// CORREÇÃO: Adicionado '-latest' para resolver o erro 404
const apiKey = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

const LINK_CARDAPIO = "https://pappipizza.cardapioweb.com";

// ===============================
// HELPERS (WHATSAPP & ÁUDIO)
// ===============================
function digitsOnly(str) { return String(str || "").replace(/\D/g, ""); }

async function sendText(to, text) { 
    const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${ENV.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: digitsOnly(to), type: "text", text: { body: text } }),
    }).catch(e => console.error("❌ Erro WA API:", e));
}

async function downloadAudio(mediaId) {
    try {
        const urlResp = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, {
            headers: { "Authorization": `Bearer ${ENV.WHATSAPP_TOKEN}` }
        });
        const { url } = await urlResp.json();
        const media = await fetch(url, { headers: { "Authorization": `Bearer ${ENV.WHATSAPP_TOKEN}` } });
        const buffer = await media.arrayBuffer();
        return Buffer.from(buffer).toString("base64");
    } catch (e) { return null; }
}

// ===============================
// CONSULTAS API (CARDÁPIO E LOJA)
// ===============================
async function getMenu() {
    try {
        const resp = await fetch("https://integracao.sandbox.cardapioweb.com/api/partner/v1/catalog", {
            headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, "Accept": "application/json" }
        });
        const data = await resp.json();
        let txt = "🍕 *MENU PAPPI PIZZA:*\n";
        data.categories?.forEach(cat => {
            if(cat.status === "ACTIVE") {
                txt += `\n*${cat.name.toUpperCase()}*\n`;
                cat.items.forEach(i => { if(i.status === "ACTIVE") txt += `- ${i.name}: R$ ${i.price.toFixed(2)}\n`; });
            }
        });
        return txt;
    } catch (e) { return "Cardápio indisponível no momento."; }
}

async function getMerchant() {
    try {
        const resp = await fetch("https://integracao.sandbox.cardapioweb.com/api/partner/v1/merchant", {
            headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, "Accept": "application/json" }
        });
        return await resp.json();
    } catch (e) { return null; }
}

// ===============================
// WEBHOOK PRINCIPAL
// ===============================
router.post("/webhook", async (req, res) => {
    res.sendStatus(200); 
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;

    try {
        let aiInput;
        // Suporte a Áudio e Texto
        if (msg.type === "audio") {
            const base64 = await downloadAudio(msg.audio.id);
            if (!base64) return sendText(from, "Puxa, não consegui ouvir o áudio. Pode escrever?");
            aiInput = [{ inlineData: { data: base64, mimeType: "audio/ogg" } }, { text: "O cliente mandou um áudio. Transcreva e responda como Pappi Pizza." }];
        } else {
            aiInput = msg.text?.body || "";
            if (!aiInput) return;
        }

        const [menu, merchant, configPix] = await Promise.all([
            getMenu(), 
            getMerchant(), 
            prisma.config.findUnique({ where: { key: "CHAVE_PIX" } })
        ]);

        const pagamentos = merchant?.métodos_de_pagamento?.filter(p => p.ativo).map(p => p.método_de_pagamento).join(", ");
        const pix = configPix?.value || "PIX: 19 9 8319 3999 - Darclee Duran";

        const PROMPT = `Você é o atendente da Pappi Pizza em Campinas.
        ENDEREÇO: ${merchant?.endereço?.rua}, ${merchant?.endereço?.número}.
        PAGAMENTOS: ${pagamentos}.
        MENU: ${menu}
        CARDÁPIO ONLINE: ${LINK_CARDAPIO}
        PIX: ${pix}`;

        const content = typeof aiInput === 'string' ? `${PROMPT}\nCliente: ${aiInput}` : [PROMPT, ...aiInput];
        const result = await model.generateContent(content);
        await sendText(from, result.response.text());

    } catch (error) {
        console.error("🔥 Erro:", error);
        const msgErro = `Ops! Tivemos um pequeno problema técnico aqui. 🍕\n\nMas não fique com fome! Peça pelo nosso cardápio online:\n${LINK_CARDAPIO}`;
        await sendText(from, msgErro);
    }
});

module.exports = router;
