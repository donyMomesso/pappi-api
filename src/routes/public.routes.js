const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { OpenAI } = require("openai");

const router = express.Router();
const prisma = new PrismaClient();

// Inicia a OpenAI (Ele vai ler a variável OPENAI_API_KEY automaticamente do Render)
const openai = new OpenAI();

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
        
        // Transforma o JSON num texto fácil para a IA ler
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
                if (!text) continue; // Por enquanto, a IA só lê texto

                try {
                    // 1. MEMÓRIA DE LONGO PRAZO (Prisma / PostgreSQL)
                    let customer = await prisma.customer.findUnique({ where: { phone: from } });
                    
                    const now = new Date();
                    let isReturningCustomer = false;

                    if (!customer) {
                        // Cliente Novo
                        customer = await prisma.customer.create({ data: { phone: from } });
                    } else {
                        // Verifica se faz mais de 2 horas desde a última mensagem (abandono ou retorno)
                        const hoursSinceLast = (now - new Date(customer.lastInteraction)) / (1000 * 60 * 60);
                        if (hoursSinceLast > 2) isReturningCustomer = true;
                        
                        // Atualiza a data do último contato
                        await prisma.customer.update({ where: { phone: from }, data: { lastInteraction: now } });
                    }

                    // 2. RECUPERA CARDÁPIO
                    const menuText = await getCatalogText();

                    // 3. PREPARA O CÉREBRO DA IA (Prompt de Neurociência)
                    const PROMPT_NEUROCIENCIA = `
Você é o atendente virtual humanizado da Pappi Pizza (Campinas-SP).
Seu tom é caloroso, simpático, com energia e usa emojis moderadamente.
Use gatilhos mentais de vendas (escassez, prova social, reciprocidade) de forma sutil e natural.

INFORMAÇÕES DO CLIENTE:
- Telefone: ${customer.phone}
- Nome no banco de dados: ${customer.name ? customer.name : "Desconhecido"}
- É um cliente retornando após algumas horas/dias? ${isReturningCustomer ? "Sim" : "Não"}

REGRAS DE OURO:
1. Se o nome for "Desconhecido", na sua PRIMEIRA resposta, seja simpático e pergunte o nome dele para anotar.
2. Se você já sabe o nome, chame-o pelo nome! Se ele estiver retornando, diga "Que bom te ver de novo, [Nome]!".
3. Você tem acesso ao cardápio abaixo. Sugira a "Pizza Margherita" ou o "Combo da promoção" dizendo que "estão saindo muito hoje" (prova social).
4. ENDEREÇO: Clientes mandam o endereço quebrado em várias linhas. Se ele mandar só a rua, não encerre o pedido. Diga: "Anotado! Qual é o número e o bairro para eu calcular a entrega certinho?". Só prossiga quando tiver Rua, Número e Bairro.
5. Se for pizza, pergunte o tamanho: Brotinho (4), Grande (8) ou Gigante (16). Se for combo, não pergunte tamanho.
6. Quando o pedido estiver completo (Itens, Tamanhos e Endereço), faça um resumo bonito do pedido e diga que ele pode confirmar para enviarmos para a cozinha.

CARDÁPIO ATUAL:
${menuText}
`;

                    // 4. MEMÓRIA DE CURTO PRAZO (Contexto da conversa atual)
                    if (!chatHistory.has(from)) {
                        chatHistory.set(from, [{ role: "system", content: PROMPT_NEUROCIENCIA }]);
                    }
                    const history = chatHistory.get(from);
                    
                    // Adiciona a mensagem nova do cliente no histórico
                    history.push({ role: "user", content: text });

                    // 5. CHAMA A OPENAI (CHATGPT)
                    const aiResponse = await openai.chat.completions.create({
                        model: "gpt-4o-mini", // Modelo super rápido e barato
                        messages: history,
                        temperature: 0.7,
                        max_tokens: 300
                    });

                    const respostaBot = aiResponse.choices[0].message.content;

                    // Salva a resposta do bot no histórico para ele não perder o fio da meada
                    history.push({ role: "assistant", content: respostaBot });
                    
                    // Limita o histórico para não gastar muita memória/tokens (guarda as últimas 15 mensagens)
                    if (history.length > 15) {
                        chatHistory.set(from, [history[0], ...history.slice(-14)]);
                    }

                    // 6. ENVIA A MENSAGEM PARA O WHATSAPP
                    await sendText(from, respostaBot);

                } catch (error) {
                    console.error("🔥 Erro na IA/Banco:", error);
                    await sendText(from, "Puxa, nossa cozinha está a todo vapor e meu sistema deu uma leve travada. Pode repetir sua última mensagem, por favor? 🍕");
                }
            }
        }
    }
});

module.exports = router;
