/**
 * 🍕 Pappi Pizza API - Versão FINAL CONECTADA (v4.0)
 * Integrações: WhatsApp Cloud + Google Maps + Cardápio Web (Oficial)
 * * Atualizações:
 * - Token e Loja Cardápio Web configurados.
 * - Validação de Endereço com Lista de Opções.
 * - Cardápio dinâmico (com backup de segurança).
 */

const express = require("express");
const app = express();

// Aumenta o limite para aceitar mensagens com mídia/botões
app.use(express.json({ limit: "20mb" }));

// =================================================================================
// 1. CONFIGURAÇÕES E CHAVES
// =================================================================================

// Chaves do Google e WhatsApp (Mantidas as anteriores)
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || "AIzaSyBx8S4Rxzj3S74knuSrwnsJqEM1WCDKLj0"; 
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "939101245961363"; 
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ""; // Configure no Render
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "pappi_verify_token";

// --- NOVAS CREDENCIAIS CARDÁPIO WEB (Inseridas) ---
const CARDAPIOWEB_BASE_URL = "https://integracao.cardapioweb.com";
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN || "457DPYEpX32TcaxL2A7YcXiLUZwkY9jucKfL2WA5";
const CARDAPIOWEB_STORE_ID = process.env.CARDAPIOWEB_STORE_ID || "5371";

// Configuração da Loja (Centro de Campinas para referência)
const STORE_LOCATION = { lat: -22.90556, lng: -47.06083 }; 
const MAX_DELIVERY_RADIUS_KM = 12;

// =================================================================================
// 2. CARDÁPIO DE BACKUP (SEGURANÇA)
// =================================================================================
// Caso a integração falhe, o bot não para de funcionar.
const FALLBACK_CATALOG = {
    categories: [
        {
            id: "cat_pizzas",
            name: "🍕 Pizzas Pappi",
            items: [
                { id: "2991", name: "Calabresa", description: "A clássica", price: 30.00 },
                { id: "2992", name: "Frango c/ Catupiry", description: "Frango desfiado temperado", price: 35.00 },
                { id: "2988", name: "Margherita", description: "Tomate e manjericão fresco", price: 32.00 },
                { id: "2995", name: "Portuguesa", description: "Completa", price: 34.00 }
            ]
        },
        {
            id: "cat_bebidas",
            name: "🥤 Bebidas",
            items: [
                { id: "3006", name: "Coca-Cola 2L", description: "Garrafa", price: 14.00 },
                { id: "3005", name: "Guaraná 2L", description: "Garrafa", price: 12.00 }
            ]
        }
    ]
};

// =================================================================================
// 3. FUNÇÕES UTILITÁRIAS (HELPERS)
// =================================================================================

function digitsOnly(str) {
    return String(str || "").replace(/\D/g, "");
}

function normalizeText(str) {
    return (str || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();
}

// Cálculo de distância (Fórmula de Haversine)
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Raio da terra em km
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
function deg2rad(deg) { return deg * (Math.PI / 180); }

// =================================================================================
// 4. INTEGRAÇÕES EXTERNAS
// =================================================================================

// --- Google Maps (Geocoding com Lista) ---
async function googleGeocode(address) {
    if (!GOOGLE_MAPS_KEY) {
        console.error("❌ Erro: GOOGLE_MAPS_KEY não configurada.");
        return [];
    }

    let query = address;
    // Força a busca em Campinas se o usuário não especificou
    if (!normalizeText(address).includes("campinas")) {
        query = `${address}, Campinas - SP`;
    }

    console.log(`🔎 Buscando no Maps: ${query}`);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:BR&language=pt-BR&key=${GOOGLE_MAPS_KEY}`;

    try {
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.status === "OK" && data.results && data.results.length > 0) {
            // Retorna até 5 resultados
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

// --- Cardápio Web (Oficial) ---
async function getCatalog() {
    const url = `${CARDAPIOWEB_BASE_URL}/api/partner/v1/catalog`;
    
    console.log("📡 Buscando cardápio na API Oficial...");

    try {
        const resp = await fetch(url, {
            headers: {
                "X-API-KEY": CARDAPIOWEB_TOKEN,
                "Accept": "application/json"
                // Algumas APIs pedem o Store ID no header também, por garantia:
                // "X-STORE-ID": CARDAPIOWEB_STORE_ID 
            },
            timeout: 8000 // 8 segundos de timeout
        });

        if (!resp.ok) {
            throw new Error(`Erro API: ${resp.status} - ${resp.statusText}`);
        }
        
        const data = await resp.json();
        
        // Verifica se veio algo útil
        if (!data.categories || data.categories.length === 0) {
            throw new Error("Catálogo veio vazio");
        }
        
        console.log("✅ Cardápio carregado com sucesso!");
        return data;

    } catch (e) {
        console.error("❌ Falha na API Cardápio Web:", e.message);
        console.log("🔄 Usando Cardápio de Backup.");
        return FALLBACK_CATALOG;
    }
}

// --- WhatsApp Sender ---
async function waSend(to, payload) {
    if (!WHATSAPP_TOKEN) return console.error("❌ Erro: WHATSAPP_TOKEN ausente.");
    
    const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    
    try {
        await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                to: digitsOnly(to),
                ...payload
            })
        });
    } catch (e) {
        console.error("❌ Erro Request WhatsApp:", e);
    }
}

async function sendText(to, text) {
    return waSend(to, { type: "text", text: { body: text } });
}

async function sendButtons(to, text, buttons) {
    return waSend(to, {
        type: "interactive",
        interactive: {
            type: "button",
            body: { text: text },
            action: {
                buttons: buttons.slice(0, 3).map(b => ({
                    type: "reply",
                    reply: { id: b.id, title: b.title.slice(0, 20) }
                }))
            }
        }
    });
}

async function sendList(to, text, buttonText, sections) {
    return waSend(to, {
        type: "interactive",
        interactive: {
            type: "list",
            body: { text: text },
            action: {
                button: buttonText.slice(0, 20),
                sections: sections
            }
        }
    });
}

async function sendLocationImage(to, lat, lng, caption) {
    const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=600x300&maptype=roadmap&markers=color:red%7C${lat},${lng}&key=${GOOGLE_MAPS_KEY}`;
    return waSend(to, {
        type: "image",
        image: { link: mapUrl, caption: caption }
    });
}

// =================================================================================
// 5. GERENCIAMENTO DE SESSÃO
// =================================================================================
const sessions = new Map();

function getSession(from) {
    if (!sessions.has(from)) {
        sessions.set(from, { step: "MENU" });
    }
    return sessions.get(from);
}

function resetSession(from) {
    sessions.set(from, { step: "MENU" });
}

// =================================================================================
// 6. LÓGICA DE PROCESSAMENTO DE ENDEREÇO
// =================================================================================

async function processSelectedAddress(from, session, geoData) {
    session.addressData = geoData;

    const dist = getDistanceFromLatLonInKm(
        STORE_LOCATION.lat, STORE_LOCATION.lng,
        geoData.location.lat, geoData.location.lng
    );

    const distFmt = dist.toFixed(1);

    if (dist > MAX_DELIVERY_RADIUS_KM) {
        await sendLocationImage(from, geoData.location.lat, geoData.location.lng, "Local encontrado");
        await sendText(from, `⚠️ O endereço fica a *${distFmt}km* da loja.\n(Raio padrão: ${MAX_DELIVERY_RADIUS_KM}km). Pode haver taxa extra.`);
        
        await sendButtons(from, "Deseja continuar?", [
            { id: "ADDR_CONFIRM", title: "Sim, Aceito Taxa" },
            { id: "ADDR_RETRY", title: "Não, Mudar Local" }
        ]);
    } else {
        await sendLocationImage(from, geoData.location.lat, geoData.location.lng, "Confirme o local");
        await sendText(from, `✅ Localizado: *${geoData.formatted}*\n📏 Distância: ${distFmt}km`);
        
        await sendButtons(from, "Este é o local correto?", [
            { id: "ADDR_CONFIRM", title: "Sim, Confirmar" },
            { id: "ADDR_RETRY", title: "Corrigir" }
        ]);
    }
}

// =================================================================================
// 7. WEBHOOK (Fluxo Principal)
// =================================================================================

app.get("/webhook", (req, res) => {
    if (
        req.query["hub.mode"] === "subscribe" &&
        req.query["hub.verify_token"] === WEBHOOK_VERIFY_TOKEN
    ) {
        res.status(200).send(req.query["hub.challenge"]);
    } else {
        res.sendStatus(403);
    }
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

                // --- COMANDOS GERAIS ---
                if (input === "menu" || input === "oi" || input === "ola" || interactiveId === "BACK_MENU") {
                    resetSession(from);
                    await sendText(from, "👋 Olá! Bem-vindo à *Pappi Pizza* 🍕\n\nSou seu atendente virtual. Escolha uma opção:");
                    await sendButtons(from, "Menu Principal", [
                        { id: "BTN_PEDIR", title: "🛒 Fazer Pedido" },
                        { id: "BTN_CARDAPIO", title: "📖 Ver Cardápio" },
                        { id: "BTN_HUMANO", title: "👨‍🍳 Falar c/ Humano" }
                    ]);
                    continue;
                }

                // --- INÍCIO ---
                if (interactiveId === "BTN_PEDIR") {
                    session.step = "ORDER_TYPE";
                    await sendButtons(from, "É entrega ou retirada?", [
                        { id: "TYPE_DELIVERY", title: "🛵 Entrega" },
                        { id: "TYPE_TAKEOUT", title: "🏃 Retirada" }
                    ]);
                    continue;
                }

                if (interactiveId === "BTN_CARDAPIO") {
                    await sendText(from, "Acesse nosso cardápio completo:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony");
                    await sendButtons(from, "O que deseja fazer?", [
                        { id: "BTN_PEDIR", title: "Pedir por aqui" },
                        { id: "BACK_MENU", title: "Voltar" }
                    ]);
                    continue;
                }

                if (interactiveId === "BTN_HUMANO") {
                    await sendText(from, "👨‍🍳 Já chamei um atendente! Aguarde um momento.");
                    continue;
                }

                // --- TIPO PEDIDO ---
                if (interactiveId === "TYPE_DELIVERY") {
                    session.orderType = "delivery";
                    session.step = "ASK_ADDRESS";
                    await sendText(from, "📍 *Entrega*\nDigite seu endereço (Rua, Número e Bairro).");
                    continue;
                }

                if (interactiveId === "TYPE_TAKEOUT") {
                    session.orderType = "takeout";
                    session.step = "SELECT_CATEGORY";
                    await sendText(from, "🏃 *Retirada*\nVamos escolher sua pizza!");
                    await startCatalogFlow(from); 
                    continue;
                }

                // --- ENDEREÇO (Com Lista) ---
                if (session.step === "ASK_ADDRESS" && !interactiveId) {
                    if (input.length < 5) {
                        await sendText(from, "❌ Endereço muito curto. Digite Rua, Número e Bairro.");
                        return;
                    }

                    await sendText(from, "🔎 Pesquisando endereço...");
                    const results = await googleGeocode(text);

                    // 1. Nenhum resultado
                    if (results.length === 0) {
                        await sendText(from, "❌ Não encontrei. Tente digitar: *Rua X, 123, Bairro Y*");
                        return;
                    }

                    // 2. Um resultado único
                    if (results.length === 1) {
                        await processSelectedAddress(from, session, results[0]);
                        return;
                    }

                    // 3. Múltiplos resultados (Lista)
                    session.candidateAddresses = results;
                    const rows = results.map((addr, index) => ({
                        id: `ADDR_OPT_${index}`,
                        title: (addr.formatted.split(",")[0] || "Opção").slice(0, 23),
                        description: addr.formatted.slice(0, 70)
                    }));

                    await sendList(from, "Encontrei esses endereços. Qual é o seu?", "Selecionar", [{ title: "Opções", rows }]);
                    return;
                }

                // Seleção da Lista de Endereço
                if (interactiveId && interactiveId.startsWith("ADDR_OPT_")) {
                    const index = parseInt(interactiveId.replace("ADDR_OPT_", ""));
                    const chosenAddr = session.candidateAddresses ? session.candidateAddresses[index] : null;

                    if (chosenAddr) {
                        await processSelectedAddress(from, session, chosenAddr);
                    } else {
                        await sendText(from, "Erro na seleção. Digite novamente.");
                    }
                    continue;
                }

                // Confirmação de Endereço
                if (interactiveId === "ADDR_RETRY") {
                    session.step = "ASK_ADDRESS";
                    await sendText(from, "Ok, digite o endereço novamente:");
                    continue;
                }

                if (interactiveId === "ADDR_CONFIRM") {
                    session.step = "SELECT_CATEGORY";
                    await sendText(from, "✅ Endereço salvo! Carregando cardápio...");
                    await startCatalogFlow(from);
                    continue;
                }

                // --- CATÁLOGO ---
                
                // Escolheu Categoria
                if (interactiveId && interactiveId.startsWith("CAT_")) {
                    const catId = interactiveId.replace("CAT_", "");
                    await showItemsFromCategory(from, catId);
                    continue;
                }

                // Escolheu Item (Sabor)
                if (interactiveId && interactiveId.startsWith("ITEM_")) {
                    const itemId = interactiveId.replace("ITEM_", "");
                    session.selectedItemId = itemId;
                    session.selectedItemName = interactiveTitle;

                    // Verifica se é Pizza pelo nome da categoria ou do item
                    const isPizza = (session.selectedCategoryName?.toLowerCase().includes("pizza")) || 
                                    (interactiveTitle.toLowerCase().includes("pizza"));

                    if (isPizza) {
                        session.step = "SELECT_SIZE";
                        await sendText(from, `🍕 Você escolheu: *${interactiveTitle}*`);
                        await sendButtons(from, "Qual o tamanho?", [
                            { id: "SIZE_BROTO", title: "Brotinho (4)" },
                            { id: "SIZE_GRANDE", title: "Grande (8)" },
                            { id: "SIZE_GIGANTE", title: "Gigante (16)" }
                        ]);
                    } else {
                        // Bebida ou Promoção (sem tamanho)
                        session.selectedSize = "Padrão";
                        await confirmOrder(from, session);
                    }
                    continue;
                }

                // Escolheu Tamanho
                if (interactiveId && interactiveId.startsWith("SIZE_")) {
                    session.selectedSize = interactiveTitle; 
                    await confirmOrder(from, session);
                    continue;
                }

                // Finalizar
                if (interactiveId === "FINISH_ORDER") {
                    const endereco = session.orderType === "delivery" && session.addressData 
                        ? session.addressData.formatted 
                        : "Retirada no Balcão";

                    const msgZap = `Olá! Gostaria de fazer um pedido:\n` +
                                   `🍕 *${session.selectedItemName}*\n` +
                                   `📏 Tamanho: ${session.selectedSize}\n` +
                                   `🛵 Tipo: ${session.orderType === 'delivery' ? 'Entrega' : 'Retirada'}\n` +
                                   `📍 Endereço: ${endereco}`;
                    
                    const link = `https://wa.me/5519982275105?text=${encodeURIComponent(msgZap)}`;
                    
                    await sendText(from, `🥳 Pedido enviado!\n\nClique abaixo para confirmar o pagamento com o atendente:\n${link}`);
                    resetSession(from);
                    continue;
                }

                // Fallback
                if (!interactiveId && session.step !== "ASK_ADDRESS") {
                    await sendText(from, "Não entendi. Digite *Menu* para voltar ao início.");
                }
            }
        }
    }
});

// =================================================================================
// 8. FUNÇÕES DO CARDÁPIO
// =================================================================================

async function startCatalogFlow(from) {
    const catalog = await getCatalog();
    const categories = catalog.categories || [];

    // Filtra e limita para não travar o WhatsApp
    const rows = categories.slice(0, 10).map(c => ({
        id: `CAT_${c.id}`,
        title: c.name.slice(0, 23),
        description: "Ver opções"
    }));

    await sendList(from, "Escolha uma categoria:", "Ver Menu", [{ title: "Cardápio", rows }]);
}

async function showItemsFromCategory(from, catId) {
    const catalog = await getCatalog();
    
    // Procura a categoria pelo ID
    const category = catalog.categories.find(c => String(c.id) === String(catId));

    if (!category) {
        await sendText(from, "Categoria não encontrada.");
        return;
    }

    getSession(from).selectedCategoryName = category.name;

    const items = category.items || [];
    const rows = items.slice(0, 10).map(item => ({
        id: `ITEM_${item.id}`,
        title: item.name.slice(0, 23),
        description: item.price ? `R$ ${item.price.toFixed(2)}` : "A consultar"
    }));

    await sendList(from, `Opções: ${category.name}`, "Escolher", [{ title: "Sabores", rows }]);
}

async function confirmOrder(from, session) {
    const endereco = session.orderType === "delivery" && session.addressData 
        ? session.addressData.formatted 
        : "Retirada";

    const resumo = `📝 *Resumo*\n` +
                   `🍕 ${session.selectedItemName}\n` +
