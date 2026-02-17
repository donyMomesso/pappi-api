const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const router = express.Router();
const prisma = new PrismaClient();

// ATUALIZAÇÃO: Definindo para a versão 2.0 Flash (substituindo a 1.5)
const apiKey = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
// ===============================
// 1. HELPERS (WHATSAPP & ÁUDIO)
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

// ATUALIZAÇÃO: Baixa o áudio direto para o buffer para a IA "ouvir"
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
// 2. CONSULTAS API (CARDÁPIO E LOJA)
// ===============================
async function getCatalogText() {
    try {
        const resp = await fetch("https://integracao.sandbox.cardapioweb.com/api/partner/v1/catalog", { 
            headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, "Accept": "application/json" } 
        });
        const data = await resp.json();
        if (!data.categories) return "Cardápio indisponível.";
        let txt = "📋 *CARDÁPIO PAPPI PIZZA:*\n";
        data.categories.forEach(cat => {
            if(cat.status === "ACTIVE") {
                txt += `\n🍕 *${cat.name.toUpperCase()}*\n`;
                cat.items.forEach(i => { if(i.status === "ACTIVE") txt += `- ${i.name}: R$ ${i.price.toFixed(2)}\n`; });
            }
        });
        return txt;
    } catch (e) { return "Erro no cardápio."; }
}

async function getMerchantInfo() {
    try {
        const resp = await fetch("https://integracao.sandbox.cardapioweb.com/api/partner/v1/merchant", {
            headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, "Accept": "application/json" }
        });
        return await resp.json();
    } catch (e) { return null; }
}

const chatHistory = new Map();

// ===============================
// 3. WEBHOOK PRINCIPAL
// ===============================
router.post("/webhook", async (req, res) => {
    res.sendStatus(200); 
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;

    try {
        let aiInput;
        // ATUALIZAÇÃO: Reconhece Áudio e Texto dinamicamente
        if (msg.type === "audio") {
            const base64 = await downloadAudio(msg.audio.id);
            if (!base64) return sendText(from, "Puxa, tive um problema com o áudio. Pode escrever?");
            aiInput = [{ inlineData: { data: base64, mimeType: "audio/ogg" } }, { text: "O cliente mandou um áudio. Transcreva e responda como Pappi Pizza." }];
        } else {
            aiInput = msg.text?.body || "";
        }

        const [menu, merchant, configPix] = await Promise.all([
            getCatalogText(),
            getMerchantInfo(),
            prisma.config.findUnique({ where: { key: "CHAVE_PIX" } })
        ]);

        const pix = configPix?.value || "PIX: 19 9 8319 3999 - Darclee Duran";

        const PROMPT = `Atendente da ${merchant?.name || "Pappi Pizza"} em ${merchant?.endereço?.cidade || "Campinas"}.
        CARDÁPIO: ${menu}
        PAGAMENTO: ${pix}
        REGRAS: Sugira Margherita, peça endereço e seja humanizado.`;

        if (!chatHistory.has(from)) chatHistory.set(from, []);
        const history = chatHistory.get(from);
        
        const content = typeof aiInput === 'string' ? `${PROMPT}\nHistórico: ${history}\nCliente: ${aiInput}` : [PROMPT, ...aiInput];
        
        const result = await model.generateContent(content);
        const respostaBot = result.response.text();

        history.push(`Cliente: ${typeof aiInput === 'string' ? aiInput : "Áudio"}`);
        history.push(`Atendente: ${respostaBot}`);
        if (history.length > 10) history.splice(0, 2);

        await sendText(from, respostaBot);

    } catch (error) {
        console.error("🔥 Erro:", error);
        await sendText(from, "Tivemos um problema! Pode repetir em 1 minuto? 🍕");
    }
});

module.exports = router;
