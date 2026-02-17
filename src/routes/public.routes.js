const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const router = express.Router();
const prisma = new PrismaClient();

// Inicializa a IA com o modelo gratuito confirmado na sua lista
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
// 2. BUSCA DO CARDÁPIO WEB (URL SANDBOX ATUALIZADA)
// ===============================
async function getCatalogText() {
    // URL de integração Sandbox fornecida
    const url = `https://integracao.sandbox.cardapioweb.com/api/partner/v1/catalog`;
    
    try {
        const resp = await fetch(url, { 
            method: 'GET',
            headers: { 
                "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, 
                "Accept": "application/json" 
            } 
        });
        const data = await resp.json();
        
        if (!data.categories || data.categories.length === 0) return "Cardápio indisponível no momento.";
        
        let menuText = "📋 *CARDÁPIO PAPPI PIZZA (Sincronizado):*\n";
        data.categories.forEach(cat => {
            if(cat.status === "ACTIVE") {
                menuText += `\n🍕 *${cat.name.toUpperCase()}*\n`;
                cat.items.forEach(item => {
                    // Itens precisam estar ativos e ter preço
                    if(item.status === "ACTIVE") {
                        menuText += `- ${item.name}: R$ ${item.price.toFixed(2)} - ${item.description || ""}\n`;
                    }
                });
            }
        });
        return menuText;
    } catch (e) {
        console.error("🔥 Erro API CardápioWeb:", e);
        return "Erro ao sincronizar cardápio.";
    }
}

// ===============================
// 3. MEMÓRIA DE CURTO PRAZO
// ===============================
const chatHistory = new Map();

// ===============================
// 4. ROTAS E WEBHOOK
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
        // 1. BUSCA O PIX NO BANCO (Regras de Inter e Titularidade)
        const configPix = await prisma.config.findUnique({ where: { key: "CHAVE_PIX" } });
        const pixTexto = configPix ? configPix.value : "PIX: 19 9 8319 3999 (Celular)\nTitular: Darclee Rodrigues Duran Momesso\nBanco: Inter";

        // 2. BUSCA O CARDÁPIO EM TEMPO REAL
        const menuOficial = await getCatalogText();

        // 3. BUSCA OU CRIA O CLIENTE (Memória de longo prazo)
        let customer = await prisma.customer.findUnique({ where: { phone: from } });
        if (!customer) {
            customer = await prisma.customer.create({ data: { phone: from } });
        } else {
            await prisma.customer.update({ where: { phone: from }, data: { lastInteraction: new Date() } });
        }

        // 4. MONTAGEM DO PROMPT DINÂMICO
        const PROMPT_NEUROCIENCIA = `
Você é o atendente humanizado da Pappi Pizza (Campinas-SP).
CLIENTE ATUAL: ${customer.name || "Dony"}

SABORES E PREÇOS OFICIAIS (Use exatamente estes):
${menuOficial}

DADOS PARA PAGAMENTO (PIX):
${pixTexto}

REGRAS RÍGIDAS:
1. Jamais invente preços. Siga a lista acima.
2. Confirme sempre Rua, Número e Bairro para a entrega.
3. Sugira a Pizza Margherita como o carro-chefe da casa.
4. Chame o cliente pelo nome assim que ele se identificar.
`;

        // 5. HISTÓRICO E GERAÇÃO DE RESPOSTA
        if (!chatHistory.has(from)) chatHistory.set(from, []);
        const history = chatHistory.get(from);
        history.push(`Cliente: ${text}`);
        if (history.length > 10) history.shift();

        const fullPrompt = `${PROMPT_NEUROCIENCIA}\n\nHistórico:\n${history.join("\n")}\n\nAtendente:`;
        const result = await model.generateContent(fullPrompt);
        const respostaBot = result.response.text();

        history.push(`Atendente: ${respostaBot}`);

        // 6. ENVIO PARA WHATSAPP
        await sendText(from, respostaBot);

    } catch (error) {
        console.error("🔥 Erro Geral:", error);
        await sendText(from, "Puxa, tivemos um soluço técnico aqui na cozinha. Pode repetir o que você disse? 🍕");
    }
});

module.exports = router;
