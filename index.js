/**
 * 🍕 Pappi Pizza API - Versão 5.0 (Blindada com Retry)
 * * Novidades:
 * - Sistema de Retentativa (Retry): Tenta 3x antes de desistir.
 * - Feedback de Espera: Avisa o cliente se estiver demorando.
 * - Zero Suposições: Só avança se tiver certeza ou confirmação.
 */

const express = require("express");
const app = express();

// Aumenta limite de dados
app.use(express.json({ limit: "20mb" }));

// =================================================================================
// 1. CONFIGURAÇÕES E CHAVES
// =================================================================================

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || "AIzaSyBx8S4Rxzj3S74knuSrwnsJqEM1WCDKLj0"; 
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "939101245961363"; 
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ""; // Configure no Render
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "pappi_verify_token";

// Credenciais Cardápio Web
const CARDAPIOWEB_BASE_URL = "https://integracao.cardapioweb.com";
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN || "457DPYEpX32TcaxL2A7YcXiLUZwkY9jucKfL2WA5";
const CARDAPIOWEB_STORE_ID = process.env.CARDAPIOWEB_STORE_ID || "5371";

// Configuração da Loja (Centro Campinas)
const STORE_LOCATION = { lat: -22.90556, lng: -47.06083 }; 
const MAX_DELIVERY_RADIUS_KM = 12;

// =================================================================================
// 2. CARDÁPIO DE SEGURANÇA (Último recurso)
// =================================================================================
const FALLBACK_CATALOG = {
    categories: [
        {
            id: "cat_pizzas",
            name: "🍕 Pizzas Pappi (Menu Básico)",
            items: [
                { id: "2991", name: "Calabresa", description: "Clássica", price: 30.00 },
                { id: "2992", name: "Frango c/ Catupiry", description: "Frango desfiado temperado", price: 35.00 },
                { id: "2988", name: "Margherita", description: "Tomate e manjericão", price: 32.00 },
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
// 3. FUNÇÕES DE AJUDA & RETENTATIVA (Retry)
// =================================================================================

function digitsOnly(str) { return String(str || "").replace(/\D/g, ""); }
function normalizeText(str) { return (str || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Cálculo de distância
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
function deg2rad(deg) { return deg * (Math.PI / 180); }

/**
 * Função inteligente que tenta buscar dados 3 vezes antes de falhar.
 * Se falhar na primeira, avisa o usuário (opcional).
 */
async function fetchWithRetry(url, options, retries = 3, delay = 1500, onRetry = null) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) {
                // Se for erro 500 (servidor), tenta de novo. Se for 400 (cliente), desiste.
                if (res.status >= 500) throw new Error(`Server Error: ${res.status}`);
                return res; // Retorna o erro 4xx para tratar lá fora
            }
            return res; // Sucesso
        } catch (err) {
            console.warn(`⚠️ Tentativa ${i + 1} falhou: ${err.message}`);
            
            if (i < retries - 1) {
                if (onRetry) await onRetry(); // Avisa o usuário se necessário
                await sleep(delay); // Espera um pouco antes de tentar de novo
            } else {
                throw err; // Se acabou as tentativas, lança o erro real
            }
        }
    }
}

// =================================================================================
// 4. INTEGRAÇÕES (Com Retry)
// =================================================================================

// --- Google Maps ---
async function googleGeocode(address, from) {
    if (!GOOGLE_MAPS_KEY) return [];

    let query = address;
    if (!normalizeText(address).includes("campinas")) query = `${address}, Campinas - SP`;
    
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:BR&language=pt-BR&key=${GOOGLE_MAPS_KEY}`;

    try {
        // Tenta buscar. Se falhar, espera e tenta de novo.
        const resp = await fetchWithRetry(url, {}, 3, 1000, async () => {
            // Se falhar a primeira, manda msg de paciência (só na primeira falha real)
            // Mas para Maps geralmente é rápido, não vamos floodar o chat.
            console.log("Retentando Google Maps...");
        });

        const data = await resp.json();
        if (data.status === "OK" && data.results.length > 0) {
            return data.results.slice(0, 5).map(res => ({
                formatted: res.formatted_address,
                location: res.geometry.location,
                placeId: res.place_id
            }));
        }
    } catch (e) {
        console.error("❌ Erro Google Maps após tentativas:", e);
    }
    return [];
}

// --- Cardápio Web ---
async function getCatalog(from) {
    const url = `${CARDAPIOWEB_BASE_URL}/api/partner/v1/catalog`;
    
    console.log("📡 Buscando cardápio...");

    try {
        // Tenta 3 vezes. Se falhar na primeira, avisa o cliente.
        const resp = await fetchWithRetry(
            url, 
            {
                headers: { "X-API-KEY": CARDAPIOWEB_TOKEN, "Accept": "application/json" },
                timeout: 8000
            }, 
            3, 
            2000, 
            async () => {
                // Callback: Executa se a primeira tentativa falhar
                await sendText(from, "⏳ O sistema do cardápio está demorando um pouquinho... Só um minuto, estou tentando conectar novamente.");
            }
        );

        if (!resp.ok) throw new Error(`Status ${resp.status}`);
        
        const data = await resp.json();
        if (!data.categories || data.categories.length === 0) throw new Error("Vazio");
        
        return data;

    } catch (e) {
        console.error("❌ Falha Cardápio Web Final:", e.message);
        await sendText(from, "⚠️ O sistema oficial está instável agora. Vou te mostrar o cardápio básico de emergência para você não ficar sem pedir.");
        return FALLBACK_CATALOG;
    }
}

// --- WhatsApp Sender ---
async function waSend(to, payload) {
    if (!WHATSAPP_TOKEN) return console.error("Sem Token WA");
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
// 5. SESSÃO
// =================================================================================
const sessions = new Map();
function getSession(from) {
    if (!sessions.has(from)) sessions.set(from, { step: "MENU" });
    return sessions.get(from);
}
function resetSession(from) { sessions.set(from, { step: "MENU" }); }

// =================================================================================
// 6. PROCESSAR ENDEREÇO
// =================================================================================
async function processSelectedAddress(from, session, geoData) {
    session.addressData = geoData;
    const dist = getDistanceFromLatLonInKm(STORE_LOCATION.lat, STORE_LOCATION.lng, geoData.location.lat, geoData.location.lng);
    const distFmt = dist.toFixed(1);

    if (dist > MAX_DELIVERY_RADIUS_KM) {
        await sendLocationImage(from, geoData.location.lat, geoData.location.lng, "Fora da área");
        await sendText(from, `⚠️ Endereço a *${distFmt}km* da loja (Limite: ${MAX_DELIVERY_RADIUS_KM}km).\nPodemos tentar entregar com taxa extra.`);
        await sendButtons(from, "Deseja continuar?", [{ id: "ADDR_CONFIRM", title: "Sim, Continuar" }, { id: "ADDR_RETRY", title: "Não, Mudar Local" }]);
    } else {
        await sendLocationImage(from, geoData.location.lat, geoData.location.lng, "Local Encontrado");
        await sendText(from, `✅ Localizado: *${geoData.formatted}*\n📏 Distância: ${distFmt}km`);
        await sendButtons(from, "Confirma este local?", [{ id: "ADDR_CONFIRM", title: "Sim, Confirmar" }, { id: "ADDR_RETRY", title: "Não, Corrigir" }]);
    }
}

// =================================================================================
// 7. WEBHOOK PRINCIPAL
// =================================================================================

app.get("/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === WEBHOOK_VERIFY_TOKEN) {
        res.status(200).send(req.query["hub.challenge"]);
    } else { res.sendStatus(403); }
});

app.post("/webhook", async (req, res) => {
    res.sendStatus(200); // ⚡ Responde rápido pro WhatsApp não ficar reenviando

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

                // --- RESET ---
                if (input === "menu" || input === "oi" || input === "ola" || interactiveId === "BACK_MENU") {
                    resetSession(from);
                    await sendText(from, "👋 Olá! Bem-vindo à *Pappi Pizza* 🍕\nEstou à disposição. Por onde começamos?");
                    await sendButtons(from, "Menu Principal", [
                        { id: "BTN_PEDIR", title: "🛒 Fazer Pedido" },
                        { id: "BTN_CARDAPIO", title: "📖 Ver Cardápio" },
                        { id: "BTN_HUMANO", title: "👨‍🍳 Atendente" }
                    ]);
                    continue;
                }

                if (interactiveId === "BTN_PEDIR") {
                    session.step = "ORDER_TYPE";
                    await sendButtons(from, "É para entrega ou retirada?", [{ id: "TYPE_DELIVERY", title: "🛵 Entrega" }, { id: "TYPE_TAKEOUT", title: "🏃 Retirada" }]);
                    continue;
                }

                if (interactiveId === "BTN_CARDAPIO") {
                    await sendText(from, "Aguarde um instante, estou pegando o link atualizado...");
                    // Pequeno delay para parecer natural
                    await sleep(1000); 
                    await sendText(from, "Aqui está: https://app.cardapioweb.com/pappi_pizza?s=dony");
                    await sendButtons(from, "Opções", [{ id: "BTN_PEDIR", title: "Fazer Pedido" }, { id: "BACK_MENU", title: "Voltar" }]);
                    continue;
                }

                if (interactiveId === "BTN_HUMANO") {
                    await sendText(from, "👨‍🍳 Chamei um atendente. Por favor, aguarde um minuto que alguém já visualiza sua mensagem.");
                    continue;
                }

                // --- TIPO ---
                if (interactiveId === "TYPE_DELIVERY") {
                    session.orderType = "delivery";
                    session.step = "ASK_ADDRESS";
                    await sendText(from, "📍 *Entrega*\nDigite o endereço: *Rua, Número e Bairro*.");
                    continue;
                }

                if (interactiveId === "TYPE_TAKEOUT") {
                    session.orderType = "takeout";
                    session.step = "SELECT_CATEGORY";
                    await sendText(from, "🏃 *Retirada*\nCarregando cardápio...");
                    await startCatalogFlow(from);
                    continue;
                }

                // --- ENDEREÇO (SEM SUPOSIÇÕES) ---
                if (session.step === "ASK_ADDRESS" && !interactiveId) {
                    if (input.length < 5) {
                        await sendText(from, "❌ Muito curto. Preciso de: Rua, Número e Bairro.");
                        return;
                    }

                    await sendText(from, "🔎 Pesquisando endereço, só um minuto...");
                    
                    const results = await googleGeocode(text, from);

                    if (results.length === 0) {
                        await sendText(from, "❌ Não encontrei esse local exato. Pode verificar se digitou o nome da rua e o número certos?");
                        return;
                    }

                    if (results.length === 1) {
                        await processSelectedAddress(from, session, results[0]);
                        return;
                    }

                    // Se tiver mais de um, não supõe! Pergunta.
                    session.candidateAddresses = results;
                    const rows = results.map((addr, index) => ({
                        id: `ADDR_OPT_${index}`,
                        title: (addr.formatted.split(",")[0] || "Opção").slice(0, 23),
                        description: addr.formatted.slice(0, 70)
                    }));
                    await sendList(from, "Encontrei esses locais. Qual deles é o seu?", "Selecionar", [{ title: "Opções", rows }]);
                    return;
                }

                if (interactiveId && interactiveId.startsWith("ADDR_OPT_")) {
                    const index = parseInt(interactiveId.replace("ADDR_OPT_", ""));
                    const chosenAddr = session.candidateAddresses ? session.candidateAddresses[index] : null;
                    if (chosenAddr) await processSelectedAddress(from, session, chosenAddr);
                    else await sendText(from, "Erro. Digite novamente.");
                    continue;
                }

                if (interactiveId === "ADDR_RETRY") {
                    session.step = "ASK_ADDRESS";
                    await sendText(from, "Ok, digite novamente (Rua, Número e Bairro):");
                    continue;
                }

                if (interactiveId === "ADDR_CONFIRM") {
                    session.step = "SELECT_CATEGORY";
                    await sendText(from, "✅ Combinado! Buscando cardápio...");
                    await startCatalogFlow(from);
                    continue;
                }

                // --- CATÁLOGO ---
                if (interactiveId && interactiveId.startsWith("CAT_")) {
                    const catId = interactiveId.replace("CAT_", "");
                    await showItemsFromCategory(from, catId);
                    continue;
                }

                if (interactiveId && interactiveId.startsWith("ITEM_")) {
                    const itemId = interactiveId.replace("ITEM_", "");
                    session.selectedItemId = itemId;
                    session.selectedItemName = interactiveTitle;

                    const isPizza = session.selectedCategoryName?.toLowerCase().includes("pizza") || interactiveTitle.toLowerCase().includes("pizza");

                    if (isPizza) {
                        session.step = "SELECT_SIZE";
                        await sendText(from, `🍕 Sabor: *${interactiveTitle}*`);
                        await sendButtons(from, "Escolha o tamanho:", [
                            { id: "SIZE_BROTO", title: "Brotinho (4)" },
                            { id: "SIZE_GRANDE", title: "Grande (8)" },
                            { id: "SIZE_GIGANTE", title: "Gigante (16)" }
                        ]);
                    } else {
                        session.selectedSize = "Padrão";
                        await confirmOrder(from, session);
                    }
                    continue;
                }

                if (interactiveId && interactiveId.startsWith("SIZE_")) {
                    session.selectedSize = interactiveTitle;
                    await confirmOrder(from, session);
                    continue;
                }

                if (interactiveId === "FINISH_ORDER") {
                    const endereco = session.orderType === "delivery" && session.addressData ? session.addressData.formatted : "Retirada";
                    const link = `https://wa.me/5519982275105?text=${encodeURIComponent(`Novo Pedido:\n${session.selectedItemName}\n${session.selectedSize}\n${session.orderType}\n${endereco}`)}`;
                    await sendText(from, `✅ Pedido Enviado!\n\nUm atendente vai confirmar o total.\nFinalizar: ${link}`);
                    resetSession(from);
                    continue;
                }

                if (!interactiveId && session.step !== "ASK_ADDRESS") {
                    await sendText(from, "Não entendi. Digite *Menu* para voltar.");
                }
            }
        }
    }
});

// --- FUNÇÕES CARDÁPIO ---
async function startCatalogFlow(from) {
    const catalog = await getCatalog(from); // Passa 'from' para poder avisar se demorar
    const categories = catalog.categories || [];

    const rows = categories.slice(0, 10).map(c => ({
        id: `CAT_${c.id}`,
        title: c.name.slice(0, 23),
        description: "Ver opções"
    }));

    await sendList(from, "O que deseja pedir?", "Cardápio", [{ title: "Categorias", rows }]);
}

async function showItemsFromCategory(from, catId) {
    const catalog = await getCatalog(from);
    const category = catalog.categories.find(c => String(c.id) === String(catId));
    
    if (!category) return sendText(from, "Categoria indisponível no momento.");
    
    getSession(from).selectedCategoryName = category.name;
    const items = category.items || [];
    
    const rows = items.slice(0, 10).map(item => ({
        id: `ITEM_${item.id}`,
        title: item.name.slice(0, 23),
        description: item.price ? `R$ ${item.price.toFixed(2)}` : ""
    }));

    await sendList(from, `Opções: ${category.name}`, "Selecionar", [{ title: "Sabores", rows }]);
}

async function confirmOrder(from, session) {
    const endereco = session.orderType === "delivery" && session.addressData ? session.addressData.formatted : "Retirada";
    const resumo = `📝 *Resumo*\n🍕 ${session.selectedItemName}\n📏 ${session.selectedSize}\n📍 ${endereco}`;
    await sendButtons(from, resumo, [{ id: "FINISH_ORDER", title: "✅ Confirmar" }, { id: "BACK_MENU", title: "❌ Cancelar" }]);
}

// SERVER
app.get("/health", (req, res) => res.json({ status: "online", store_id: CARDAPIOWEB_STORE_ID }));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🔥 Pappi API v5.0 (Retry) rodando na porta ${PORT}`));
