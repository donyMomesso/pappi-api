const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const router = express.Router();
const prisma = new PrismaClient();

// Inicializa a IA do Google com o modelo correto e atualizado
const apiKey = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

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
// 2. BUSCA DO CARDÁPIO WEB
// ===============================
async function getCatalogText() {
    const url = `${ENV.CARDAPIOWEB_BASE_URL}/api/partner/v1/catalog`;
    try {
        const resp = await fetch(url, { headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, "Accept": "application/json" } });
        const data = await resp.json();
        
        if (!data.categories) return "Cardápio indisponível no momento.";
        
        let menuText = "CARDÁPIO PAPPI PIZZA:\n";
        data.categories.forEach(cat => {
            if(cat.status === "ACTIVE") {
                menuText += `\n[Categoria: ${cat.name}]\n`;
                cat.items.forEach(item => {
                    if(item.status === "ACTIVE") {
                        menuText += `- ${item.name} (R$ ${item.price}) - ${item.description || ""}\n`;
                    }
                });
            }
        });
        return menuText;
    } catch (e) {
        return "Erro ao ler cardápio.";
    }
}

// ===============================
// 3. MEMÓRIA DE CONVERSA (Curto Prazo)
// ===============================
const chatHistory = new Map();

// ===============================
// 4. ROTAS DO WEBHOOK
// ===============================
router.get("/", (req, res) => res.send("Pappi API IA online 🧠✅"));
router.get("/health", (req, res) => res.json({ ok: true, app: "Pappi Pizza IA" }));

router.get("/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === ENV.WEBHOOK_VERIFY_TOKEN) {
        return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.sendStatus(403);
});

router.post("/webhook", async (req, res) => {
    res.sendStatus(200); 
    const body = req.body;
    if (!body.entry) return;

    for (const entry of body.entry) {
        for (const change of entry.changes || []) {
            const value = change.value;
            if (!value.messages) continue;

            for (const msg of value.messages) {
                const from = msg.from;
                const text = msg.text?.body || "";
                if (!text) continue; 

                try {
                    // Proteção caso falte a chave
                    if (!apiKey) throw new Error("Chave GEMINI_API_KEY não encontrada no Render.");

                    // 1. MEMÓRIA DE LONGO PRAZO (Prisma / PostgreSQL)
                    let customer = await prisma.customer.findUnique({ where: { phone: from } });
                    
                    const now = new Date();
                    let isReturningCustomer = false;

                    if (!customer) {
                        customer = await prisma.customer.create({ data: { phone: from } });
                    } else {
                        const hoursSinceLast = (now - new Date(customer.lastInteraction)) / (1000 * 60 * 60);
                        if (hoursSinceLast > 2) isReturningCustomer = true;
                        
                        await prisma.customer.update({ where: { phone: from }, data: { lastInteraction: now } });
                    }

                    // 2. RECUPERA CARDÁPIO
                    const menuText = await getCatalogText();

                    // 3. PREPARA O CÉREBRO DA IA (Prompt de Neurociência)
                    const PROMPT_NEUROCIENCIA = `
Você é o atendente virtual humanizado da Pappi Pizza (Campinas-SP).
