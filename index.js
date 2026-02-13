/**
 * 🍕 Pappi Pizza API - Versão 6.0 (FINAL CORRIGIDA)
 * * CORREÇÕES CRÍTICAS:
 * 1. Bug do "Não entendi" no endereço resolvido (prioridade de texto).
 * 2. Integração de Webhook do Cardápio Web (recebe atualização de status).
 * 3. Lógica de Endereço com Google Maps mais robusta.
 */

const express = require("express");
const app = express();

// Aumenta limite para receber JSON grandes (imagens/logs)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// =================================================================================
// 1. CHAVES E CONFIGURAÇÕES
// =================================================================================

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || "AIzaSyBx8S4Rxzj3S74knuSrwnsJqEM1WCDKLj0"; 
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "939101245961363"; 
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ""; // Configure no Render
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "pappi_verify_token";

// Cardápio Web (Suas chaves reais)
const CARDAPIOWEB_BASE_URL = "https://integracao.cardapioweb.com";
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN || "457DPYEpX32TcaxL2A7YcXiLUZwkY9jucKfL2WA5";
const CARDAPIOWEB_STORE_ID = process.env.CARDAPIOWEB_STORE_ID || "5371";

// Configuração da Loja (Centro Campinas)
const STORE_LOCATION = { lat: -22.90556, lng: -47.06083 }; 
const MAX_DELIVERY_RADIUS_KM = 12;

// =================================================================================
// 2. HELPERS (Ferramentas)
// =================================================================================

function digitsOnly(str) { return String(str || "").replace(/\D/g, ""); }
function normalizeText(str) { return (str || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Distância
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
function deg2rad(deg) { return deg * (Math.PI / 180); }

// =================================================================================
// 3. INTEGRAÇÕES
// =================================================================================

// --- Google Maps ---
async function googleGeocode(address) {
    if (!GOOGLE_MAPS_KEY) return [];

    let query = address;
    // Se não escreveu "Campinas", adiciona para ajudar o Google
    if (!normalizeText(address).includes("campinas")) {
        query = `${address}, Campinas - SP`;
    }
    
    console.log(`🔎 Google Maps buscando: "${query}"`);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:BR&language=pt-BR&key=${GOOGLE_MAPS_KEY}`;

    try {
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.status === "OK" && data.results.length > 0) {
            return data.results.slice(0, 5).map(res => ({
                formatted: res.formatted_address,
                location: res.geometry.location,
                placeId: res.place_id
            }));
        }
    } catch (e) {
        console.error("❌ Erro Google Maps:", e);
    }
    return [];
}

// --- Cardápio Web (Catálogo) ---
async function getCatalog() {
    const url = `${CARDAPIOWEB_BASE_URL}/api/partner/v1/catalog`;
    try {
        const resp = await fetch(url, {
            headers: { "X-API-KEY": CARDAPIOWEB_TOKEN, "Accept": "application/json" },
            timeout: 8000
        });
        if (!resp.ok) throw new Error("Erro API");
        const data = await resp.json();
        if (!data.categories) throw new Error("Vazio");
        return data;
    } catch (e) {
        console.error("Erro Cardápio Web, usando backup.");
        // Retorna backup básico para não travar
        return {
            categories: [
                { id: "100", name: "🍕 Pizzas", items: [{id:"1", name:"Calabresa", price:30}, {id:"2", name:"Mussarela", price:30}] },
                { id: "200", name: "🥤 Bebidas", items: [{id:"3", name:"Coca-Cola", price:12}] }
            ]
        };
    }
}

// --- WhatsApp Envio ---
async function waSend(to, payload) {
    if (!WHATSAPP_TOKEN) return console.error("⚠️ Falta TOKEN WhatsApp");
    const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    try {
        await fetch(url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ messaging_product: "whatsapp", to: digitsOnly(to), ...payload })
        });
    } catch (e) { console.error("Erro WA:", e); }
}

async function sendText(to, text) { return waSend(to, { type: "text", text: { body: text } }); }

async function sendButtons(to, text, buttons) {
    return waSend(to, { type: "interactive", interactive: { type: "button", body: { text: text }, action: { buttons: buttons.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) } } });
}

async function sendList(to, text, buttonText, sections) {
    return waSend(to, { type: "interactive", interactive: { type: "list", body: { text: text }, action: { button: buttonText.slice(0, 20), sections: sections } } });
}

async function sendLocationImage(to, lat, lng, caption) {
    const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=600x300&maptype=roadmap&markers=color:red%7C${lat},${lng}&key=${GOOGLE_MAPS_KEY}`;
    return waSend(to, { type: "image", image: { link: mapUrl, caption: caption } });
}

// =================================================================================
// 4. SESSÃO (Memória)
// =================================================================================
const sessions = new Map();
// Cache simples para mapear ID do pedido -> Telefone do Cliente (para avisar status)
const orderToPhoneMap = new Map(); 

function getSession(from) {
    if (!sessions.has(from)) sessions.set(from, { step: "MENU" });
    return sessions.get(from);
}
function resetSession(from) { sessions.set(from, { step: "MENU" }); }

// =================================================================================
// 5. ROTA DE STATUS DO PEDIDO (WEBHOOK CARDÁPIO WEB)
// =================================================================================
// O Cardápio Web manda POST aqui quando o pedido muda de status
app.post("/cardapioweb/webhook", async (req, res) => {
    res.status(200).json({ status: "ok" }); // Responde 200 rápido para não travar

    try {
        const body = req.body;
        console.log("🔔 Webhook Cardápio Web recebido:", JSON.stringify(body));

        const status = body.status; // pending, confirmed, delivered, etc
        const orderId = body.id || body.order_id;
        
        // Tenta descobrir o telefone do cliente
        let phone = null;
        if (body.customer && body.customer.phone) {
            phone = digitsOnly(body.customer.phone);
        } else if (orderToPhoneMap.has(String(orderId))) {
            phone = orderToPhoneMap.get(String(orderId));
        }

        if (!phone) {
            console.log("⚠️ Webhook recebido mas sem telefone do cliente. Ignorando envio.");
            return;
        }

        // Traduz o status para mensagem amigável
        let msg = "";
        switch (status) {
            case "confirmed": msg = `🔥 Seu pedido #${orderId} foi confirmado e já está sendo preparado!`; break;
            case "ready": msg = `🍕 Oba! Seu pedido #${orderId} está pronto!`; break;
            case "released": msg = `🛵 Seu pedido #${orderId} saiu para entrega. Fique atento!`; break;
            case "delivered": msg = `✅ Pedido #${orderId} entregue. Bom apetite!`; break;
            case "canceled": msg = `❌ O pedido #${orderId} foi cancelado. Entre em contato se houver dúvidas.`; break;
        }

        if (msg) {
            await sendText(phone, msg);
        }

    } catch (e) {
        console.error("Erro processando webhook Cardápio Web:", e);
    }
});

// =================================================================================
// 6. ROTA WHATSAPP (Fluxo Principal)
// =================================================================================

app.get("/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === WEBHOOK_VERIFY_TOKEN) {
        res.status(200).send(req.query["hub.challenge"]);
    } else { res.sendStatus(403); }
});

app.post("/webhook", async (req, res) => {
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
                
                const interactive = msg.interactive;
                const interactiveId = interactive?.button_reply?.id || interactive?.list_reply?.id;
                const interactiveTitle = interactive?.button_reply?.title || interactive?.list_reply?.title;

                const session = getSession(from);
                const input = normalizeText(text);

                console.log(`📩 [${from}] Step: ${session.step} | Input: ${text || interactiveId}`);

                // --- RESET GLOBAL ---
                if (input === "menu" || input === "oi" || interactiveId === "BACK_MENU") {
                    resetSession(from);
                    await sendText(from, "👋 Bem-vindo à Pappi Pizza! 🍕\nComo posso ajudar?");
                    await sendButtons(from, "Menu Principal", [
                        { id: "BTN_PEDIR", title: "🛒 Fazer Pedido" },
                        { id: "BTN_CARDAPIO", title: "📖 Ver Cardápio" },
                        { id: "BTN_HUMANO", title: "👨‍🍳 Falar c/ Humano" }
                    ]);
                    continue;
                }

                // --- FLUXO DE PEDIDO ---
                if (interactiveId === "BTN_PEDIR") {
                    session.step = "ORDER_TYPE";
                    await sendButtons(from, "É entrega ou retirada?", [
                        { id: "TYPE_DELIVERY", title: "🛵 Entrega" },
                        { id: "TYPE_TAKEOUT", title: "🏃 Retirada" }
                    ]);
                    continue;
                }

                if (interactiveId === "BTN_CARDAPIO") {
                    await sendText(from, "Acesse: https://app.cardapioweb.com/pappi_pizza?s=dony");
                    continue;
                }

                // --- TIPO DE ENTREGA ---
                if (interactiveId === "TYPE_DELIVERY") {
                    session.orderType = "delivery";
                    session.step = "ASK_ADDRESS"; // <--- DEFINE O PASSO AQUI
                    await sendText(from, "📍 *Entrega*\nPor favor, digite seu endereço:\n(Ex: Rua Maniel Carvalho, 53)");
                    continue; // Para aqui e espera a próxima mensagem (que será o texto)
                }

                if (interactiveId === "TYPE_TAKEOUT") {
                    session.orderType = "takeout";
                    session.step = "SELECT_CATEGORY";
                    await startCatalogFlow(from);
                    continue;
                }

                // --- 🚨 CORREÇÃO CRÍTICA: PROCESSAMENTO DE ENDEREÇO ---
                // Verifica se estamos esperando endereço E se não é um botão clicado
                if (session.step === "ASK_ADDRESS" && !interactiveId) {
                    
                    if (input.length < 5) {
                        await sendText(from, "❌ Endereço muito curto. Digite Rua e Número.");
                        return;
                    }

                    await sendText(from, "🔎 Buscando endereço...");
                    const results = await googleGeocode(text);

                    if (results.length === 0) {
                        await sendText(from, "❌ Não encontrei. Tente digitar: *Nome da Rua, Número, Bairro*");
                        return;
                    }

                    if (results.length === 1) {
                        await processAddress(from, session, results[0]);
                    } else {
                        // Lista para desambiguação
                        session.candidateAddresses = results;
                        const rows = results.map((addr, index) => ({
                            id: `ADDR_OPT_${index}`,
                            title: (addr.formatted.split(",")[0] || "Opção").slice(0, 23),
                            description: addr.formatted.slice(0, 70)
                        }));
                        await sendList(from, "Qual destes é o seu?", "Selecionar", [{ title: "Opções", rows }]);
                    }
                    return; // IMPORTANTE: Return para não cair no "Não entendi"
                }

                // --- RESPOSTA DA LISTA DE ENDEREÇO ---
                if (interactiveId && interactiveId.startsWith("ADDR_OPT_")) {
                    const idx = parseInt(interactiveId.replace("ADDR_OPT_", ""));
                    const chosen = session.candidateAddresses[idx];
                    await processAddress(from, session, chosen);
                    continue;
                }

                if (interactiveId === "ADDR_CONFIRM") {
                    session.step = "SELECT_CATEGORY";
                    await sendText(from, "✅ Endereço confirmado! Carregando cardápio...");
                    await startCatalogFlow(from);
                    continue;
                }
                
                if (interactiveId === "ADDR_RETRY") {
                    session.step = "ASK_ADDRESS";
                    await sendText(from, "Ok, digite o endereço novamente:");
                    continue;
                }

                // --- CATÁLOGO E ITENS ---
                if (interactiveId && interactiveId.startsWith("CAT_")) {
                    const catId = interactiveId.replace("CAT_", "");
                    await showItems(from, catId);
                    continue;
                }

                if (interactiveId && interactiveId.startsWith("ITEM_")) {
                    session.selectedItemName = interactiveTitle;
                    
                    // Lógica simples: se tem "Pizza" no nome, pede tamanho
                    if (interactiveTitle.toLowerCase().includes("pizza") || session.catName?.includes("Pizza")) {
                        session.step = "SIZE";
                        await sendButtons(from, `Tamanho da ${interactiveTitle}?`, [
                            {id: "SZ_BROTO", title: "Brotinho (4)"},
                            {id: "SZ_GRANDE", title: "Grande (8)"},
                            {id: "SZ_GIGANTE", title: "Gigante (16)"}
                        ]);
                    } else {
                        session.selectedSize = "Padrão";
                        await confirmOrder(from, session);
                    }
                    continue;
                }

                if (interactiveId && interactiveId.startsWith("SZ_")) {
                    session.selectedSize = interactiveTitle;
                    await confirmOrder(from, session);
                    continue;
                }

                // --- FINALIZAÇÃO ---
                if (interactiveId === "FINISH") {
                    const address = session.orderType === "delivery" ? session.addressData.formatted : "Retirada";
                    const link = `https://wa.me/5519982275105?text=${encodeURIComponent(`Novo Pedido:\n${session.selectedItemName}\n${session.selectedSize}\n${session.orderType}\n${address}`)}`;
                    await sendText(from, `🥳 Pedido enviado!\nClique para confirmar: ${link}`);
                    resetSession(from);
                    continue;
                }

                // --- FALLBACK (Só cai aqui se nada acima der match) ---
                if (!interactiveId && session.step !== "ASK_ADDRESS") {
                    await sendText(from, "Não entendi. Digite *Menu* para voltar.");
                }
            }
        }
    }
});

// =================================================================================
// 7. FUNÇÕES AUXILIARES DE FLUXO
// =================================================================================

async function processAddress(from, session, geoData) {
    session.addressData = geoData;
    const dist = getDistanceFromLatLonInKm(STORE_LOCATION.lat, STORE_LOCATION.lng, geoData.location.lat, geoData.location.lng);
    
    if (dist > MAX_DELIVERY_RADIUS_KM) {
        await sendText(from, `⚠️ Esse local fica a ${dist.toFixed(1)}km (Fora do raio de ${MAX_DELIVERY_RADIUS_KM}km).\nPodemos ter taxa extra.`);
        await sendButtons(from, "Continuar?", [{id:"ADDR_CONFIRM", title:"Sim"}, {id:"ADDR_RETRY", title:"Não, mudar"}]);
    } else {
        await sendLocationImage(from, geoData.location.lat, geoData.location.lng, "Local encontrado");
        await sendButtons(from, `Confirma: ${geoData.formatted}?`, [{id:"ADDR_CONFIRM", title:"Sim, Confirmar"}, {id:"ADDR_RETRY", title:"Corrigir"}]);
    }
}

async function startCatalogFlow(from) {
    const data = await getCatalog();
    const rows = data.categories.slice(0, 10).map(c => ({
        id: `CAT_${c.id}`, title: c.name.slice(0,23), description: "Ver opções"
    }));
    await sendList(from, "Escolha a categoria:", "Cardápio", [{title:"Menu", rows}]);
}

async function showItems(from, catId) {
    const data = await getCatalog();
    const cat = data.categories.find(c => String(c.id) === String(catId));
    if (!cat) return sendText(from, "Categoria erro.");
    
    getSession(from).catName = cat.name; // Salva para saber se é pizza depois
    const rows = cat.items.slice(0, 10).map(i => ({
        id: `ITEM_${i.id}`, title: i.name.slice(0,23), description: `R$ ${i.price}`
    }));
    await sendList(from, `Opções de ${cat.name}`, "Selecionar", [{title:"Itens", rows}]);
}

async function confirmOrder(from, session) {
    const addr = session.orderType === "delivery" ? session.addressData.formatted : "Retirada";
    const msg = `Resumo:\n${session.selectedItemName}\n${session.selectedSize}\n${addr}`;
    await sendButtons(from, msg, [{id:"FINISH", title:"✅ Confirmar"}, {id:"BACK_MENU", title:"❌ Cancelar"}]);
}

// =================================================================================
// 8. SERVIDOR
// =================================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🔥 API V6 Rodando na porta ${PORT}`));
