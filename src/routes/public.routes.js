const express = require("express");
const ENV = require("../config/env");

const router = express.Router();

// ===============================
// 1. HELPERS E FUNÇÕES GERAIS
// ===============================
function digitsOnly(str) { return String(str || "").replace(/\D/g, ""); }
function normalizeText(str) { return (str || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim(); }

function deg2rad(deg) { return deg * (Math.PI / 180); }
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// ===============================
// 2. INTEGRAÇÕES (Google & Cardápio)
// ===============================
async function googleGeocode(address) {
    if (!ENV.GOOGLE_MAPS_API_KEY) return [];
    let query = address;
    if (!normalizeText(address).includes("campinas")) query = `${address}, Campinas - SP`;
    
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:BR&language=pt-BR&key=${ENV.GOOGLE_MAPS_API_KEY}`;
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
    } catch (e) { console.error("❌ Erro Maps:", e); }
    return [];
}

async function getCatalog() {
    // Busca direto no seu Cardápio Web!
    const url = `${ENV.CARDAPIOWEB_BASE_URL}/api/partner/v1/catalog`;
    try {
        const resp = await fetch(url, {
            headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, "Accept": "application/json" }
        });
        const data = await resp.json();
        return data.categories ? data : { categories: [] };
    } catch (e) {
        console.error("❌ Erro Cardápio Web:", e.message);
        return { categories: [] };
    }
}

// ===============================
// 3. WHATSAPP ENGINE
// ===============================
async function waSend(payload) {
    if (!ENV.WHATSAPP_TOKEN || !ENV.WHATSAPP_PHONE_NUMBER_ID) return;
    const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${ENV.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).catch(e => console.error("❌ Erro WA API:", e));
}

async function sendText(to, text) { return waSend({ messaging_product: "whatsapp", to: digitsOnly(to), type: "text", text: { body: text } }); }
async function sendButtons(to, text, buttons) {
    return waSend({ messaging_product: "whatsapp", to: digitsOnly(to), type: "interactive", interactive: { type: "button", body: { text: text }, action: { buttons: buttons.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) } } });
}
async function sendList(to, text, buttonText, sections) {
    return waSend({ messaging_product: "whatsapp", to: digitsOnly(to), type: "interactive", interactive: { type: "list", body: { text: text }, action: { button: buttonText.slice(0, 20), sections: sections } } });
}
async function sendLocationImage(to, lat, lng, caption) {
    if (!ENV.GOOGLE_MAPS_API_KEY) return;
    const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=16&size=600x300&maptype=roadmap&markers=color:red%7C${lat},${lng}&key=${ENV.GOOGLE_MAPS_API_KEY}`;
    return waSend({ messaging_product: "whatsapp", to: digitsOnly(to), type: "image", image: { link: mapUrl, caption: caption } });
}

// ===============================
// 4. GERENCIADOR DE SESSÕES
// ===============================
const sessions = new Map();
function getSession(from) {
    if (!sessions.has(from)) sessions.set(from, { step: "MENU" });
    return sessions.get(from);
}
function resetSession(from) { sessions.set(from, { step: "MENU" }); }

// ===============================
// 5. ROTAS DA API
// ===============================
router.get("/", (req, res) => res.send("Pappi API online ✅"));
router.get("/health", (req, res) => res.json({ ok: true, app: "Pappi Pizza" }));

// Verificação do Facebook
router.get("/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === ENV.WEBHOOK_VERIFY_TOKEN) {
        return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.sendStatus(403);
});

// Recebimento de Mensagens
router.post("/webhook", async (req, res) => {
    res.sendStatus(200); // Meta exige resposta imediata
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

                // --- RESET E MENU INICIAL ---
                if (input === "menu" || input === "oi" || input === "ola" || interactiveId === "BACK_MENU") {
                    resetSession(from);
                    await sendText(from, "👋 Olá! Sou o assistente virtual da *Pappi Pizza* 🍕\n\nComo posso te ajudar hoje?");
                    await sendButtons(from, "Escolha uma opção:", [
                        { id: "BTN_PEDIR", title: "🛒 Fazer Pedido" },
                        { id: "BTN_CARDAPIO", title: "📖 Ver Cardápio Web" },
                        { id: "BTN_HUMANO", title: "👨‍🍳 Falar c/ Humano" }
                    ]);
                    continue;
                }

                if (interactiveId === "BTN_CARDAPIO") {
                    await sendText(from, "Acesse nosso cardápio completo com fotos:\nhttps://app.cardapioweb.com/pappi_pizza");
                    await sendButtons(from, "Quer pedir por aqui mesmo?", [{ id: "BTN_PEDIR", title: "Sim, Pedir aqui" }, { id: "BACK_MENU", title: "Voltar" }]);
                    continue;
                }

                if (interactiveId === "BTN_HUMANO") {
                    await sendText(from, "👨‍🍳 Chamei um atendente! Aguarde um instante que já te respondemos.");
                    continue;
                }

                // --- FLUXO DE PEDIDO ---
                if (interactiveId === "BTN_PEDIR") {
                    session.step = "ORDER_TYPE";
                    await sendButtons(from, "Maravilha! É para entrega ou retirada?", [
                        { id: "TYPE_DELIVERY", title: "🛵 Entrega" },
                        { id: "TYPE_TAKEOUT", title: "🏃 Retirada" }
                    ]);
                    continue;
                }

                if (interactiveId === "TYPE_DELIVERY") {
                    session.orderType = "delivery";
                    session.step = "ASK_ADDRESS";
                    await sendText(from, "📍 *Entrega*\nPor favor, digite seu endereço (Pode mandar a Rua e Número, ou apenas o CEP).");
                    continue;
                }

                if (interactiveId === "TYPE_TAKEOUT") {
                    session.orderType = "takeout";
                    session.step = "SELECT_CATEGORY";
                    await sendText(from, "🏃 *Retirada*\nCerto! Vamos escolher o que você quer comer.");
                    await startCatalogFlow(from);
                    continue;
                }

                // --- GOOGLE MAPS (ENDEREÇO) ---
                if (session.step === "ASK_ADDRESS" && !interactiveId) {
                    if (input.length < 5) {
                        await sendText(from, "❌ Endereço muito curto. Digite a Rua e o Número, por favor.");
                        return;
                    }
                    await sendText(from, "🔎 Buscando seu endereço no mapa...");
                    const results = await googleGeocode(text);

                    if (results.length === 0) {
                        await sendText(from, "❌ Hum, não achei esse local.\nTente digitar assim: *Rua Exemplo, 123, Bairro*");
                        return;
                    }

                    if (results.length === 1) {
                        await processAddress(from, session, results[0]);
                    } else {
                        session.candidateAddresses = results;
                        const rows = results.map((addr, index) => ({
                            id: `ADDR_OPT_${index}`,
                            title: (addr.formatted.split(",")[0] || "Opção").slice(0, 23),
                            description: addr.formatted.slice(0, 70)
                        }));
                        await sendList(from, "Encontrei esses locais. Qual é o exato?", "Selecionar", [{ title: "Endereços", rows }]);
                    }
                    return; 
                }

                if (interactiveId && interactiveId.startsWith("ADDR_OPT_")) {
                    const idx = parseInt(interactiveId.replace("ADDR_OPT_", ""));
                    const chosen = session.candidateAddresses[idx];
                    if (chosen) await processAddress(from, session, chosen);
                    else await sendText(from, "Erro na seleção. Digite novamente o endereço.");
                    continue;
                }

                if (interactiveId === "ADDR_CONFIRM") {
                    session.step = "SELECT_CATEGORY";
                    await sendText(from, "✅ Endereço confirmado!");
                    await startCatalogFlow(from);
                    continue;
                }

                if (interactiveId === "ADDR_RETRY") {
                    session.step = "ASK_ADDRESS";
                    await sendText(from, "Sem problemas, digite o endereço novamente:");
                    continue;
                }

                // --- CARDÁPIO WEB ---
                if (interactiveId && interactiveId.startsWith("CAT_")) {
                    const catId = interactiveId.replace("CAT_", "");
                    await showItems(from, catId);
                    continue;
                }

                // --- ESCOLHA DE ITEM ---
                if (interactiveId && interactiveId.startsWith("ITEM_")) {
                    const itemId = interactiveId.replace("ITEM_", "");
                    session.selectedItemId = itemId;
                    session.selectedItemName = interactiveTitle;

                    const isCombo = session.itemKinds && session.itemKinds[itemId] === 'combo';
                    const isPizza = (session.selectedCatName?.toLowerCase().includes("pizza")) || (interactiveTitle.toLowerCase().includes("pizza"));
                    const isBebida = (session.selectedCatName?.toLowerCase().includes("bebida"));

                    if (isPizza && !isCombo && !isBebida) {
                        session.step = "SIZE";
                        await sendText(from, `🍕 Você escolheu: *${interactiveTitle}*`);
                        await sendButtons(from, "Qual o tamanho da sua fome?", [
                            { id: "SZ_BROTO", title: "Brotinho (4 pedaços)" },
                            { id: "SZ_GRANDE", title: "Grande (8) Família" },
                            { id: "SZ_GIGANTE", title: "Gigante (16 pedaços)" }
                        ]);
                    } else {
                        session.selectedSize = isCombo ? "Combo/Promoção" : "Padrão";
                        await confirmOrder(from, session);
                    }
                    continue;
                }

                // --- SELEÇÃO DE TAMANHO (Botões ou Texto) ---
                if (session.step === "SIZE" && !interactiveId) {
                    if (input.includes("8") || input.includes("grande") || input.includes("familia")) {
                        session.selectedSize = "Grande (8 pedaços)";
                        await confirmOrder(from, session);
                    } else if (input.includes("16") || input.includes("gigante")) {
                        session.selectedSize = "Gigante (16 pedaços)";
                        await confirmOrder(from, session);
                    } else if (input.includes("4") || input.includes("broto") || input.includes("brotinho")) {
                        session.selectedSize = "Brotinho (4 pedaços)";
                        await confirmOrder(from, session);
                    } else {
                        await sendText(from, "🤔 Hum, não entendi o tamanho.\nPor favor, escolha clicando nos botões acima ou digite: *4, 8 ou 16* pedaços.");
                    }
                    continue;
                }

                if (interactiveId && interactiveId.startsWith("SZ_")) {
                    session.selectedSize = interactiveTitle;
                    await confirmOrder(from, session);
                    continue;
                }

                // --- FINALIZAR PEDIDO ---
                if (interactiveId === "FINISH") {
                    const address = session.orderType === "delivery" ? session.addressData.formatted : "Retirada no Balcão";
                    
                    const msgZap = `Olá! Meu pedido está pronto para enviar pra cozinha:\n\n` +
                                   `🛒 Item: *${session.selectedItemName}*\n` +
                                   `📏 Tamanho: *${session.selectedSize}*\n` +
                                   `🛵 Tipo: *${session.orderType === 'delivery' ? 'Entrega' : 'Retirada'}*\n` +
                                   `📍 Endereço: ${address}`;

                    const link = `https://wa.me/5519982275105?text=${encodeURIComponent(msgZap)}`;
                    
                    await sendText(from, `🥳 Tudo certo!\n\nClique no link abaixo para enviar o pedido direto para o nosso painel e combinarmos o pagamento:\n\n🔗 ${link}`);
                    resetSession(from);
                    continue;
                }

                // --- FALLBACK (Não entendeu) ---
                if (!interactiveId && session.step !== "ASK_ADDRESS" && session.step !== "SIZE") {
                    await sendText(from, "🤔 Desculpe, não entendi. Digite *Menu* para começarmos de novo.");
                }
            }
        }
    }
});

// ===============================
// 6. FUNÇÕES DE FLUXO E LÓGICA
// ===============================
async function processAddress(from, session, geoData) {
    session.addressData = geoData;
    let distFmt = "N/A";
    let dist = 0;
    
    // Calcula a distância se tiver latitude e longitude da loja configurados no env.js
    if (ENV.STORE_LAT && ENV.STORE_LNG) {
        dist = getDistanceFromLatLonInKm(ENV.STORE_LAT, ENV.STORE_LNG, geoData.location.lat, geoData.location.lng);
        distFmt = dist.toFixed(1);
    }

    if (dist > 12) { // 12km de limite
        await sendLocationImage(from, geoData.location.lat, geoData.location.lng, "Local da Entrega");
        await sendText(from, `⚠️ O endereço fica a *${distFmt}km* daqui.\nPodemos verificar se um motoboy parceiro entrega aí, mas a taxa será diferente.`);
        await sendButtons(from, "Deseja continuar?", [{id:"ADDR_CONFIRM", title:"Sim, Continuar"}, {id:"ADDR_RETRY", title:"Não, Mudar"}]);
    } else {
        await sendLocationImage(from, geoData.location.lat, geoData.location.lng, "Local da Entrega");
        const distMsg = distFmt !== "N/A" ? `\n📏 Distância: ${distFmt}km` : "";
        await sendText(from, `✅ Endereço: *${geoData.formatted}*${distMsg}`);
        await sendButtons(from, "O local está exato?", [{id:"ADDR_CONFIRM", title:"Sim, Confirmar"}, {id:"ADDR_RETRY", title:"Corrigir"}]);
    }
}

async function startCatalogFlow(from) {
    const data = await getCatalog();
    const categories = data.categories || [];
    
    if (categories.length === 0) {
        return sendText(from, "Nosso cardápio está sendo atualizado no momento! Digite *Menu* para tentar de novo.");
    }

    const rows = categories.slice(0, 10).map(c => ({
        id: `CAT_${c.id}`,
        title: c.name.slice(0, 23),
        description: c.description ? c.description.slice(0, 70) : "Toque para ver"
    }));

    await sendList(from, "O que você manda hoje?", "Ver Categorias", [{ title: "Nosso Menu", rows }]);
}

async function showItems(from, catId) {
    const data = await getCatalog();
    const category = data.categories.find(c => String(c.id) === String(catId));
    
    if (!category) return sendText(from, "Categoria indisponível.");
    
    const session = getSession(from);
    session.selectedCatName = category.name;
    session.itemKinds = {}; 

    const items = category.items || [];
    const rows = items.slice(0, 10).map(item => {
        session.itemKinds[item.id] = item.kind; 
        return {
            id: `ITEM_${item.id}`,
            title: item.name.slice(0, 23),
            description: item.price ? `A partir de R$ ${item.price.toFixed(2)}` : "Ver opções"
        };
    });

    await sendList(from, `Sabores / Opções de ${category.name}`, "Escolher", [{ title: "Itens", rows }]);
}

async function confirmOrder(from, session) {
    const address = session.orderType === "delivery" ? session.addressData.formatted : "Retirada";
    
    const resumo = `📝 *Resumo do Pedido*\n\n` +
                   `🛒 Item: *${session.selectedItemName}*\n` +
                   `📏 Tamanho/Tipo: ${session.selectedSize}\n` +
                   `📍 Local: ${address}\n\n` +
                   `Posso mandar pra cozinha?`;

    await sendButtons(from, resumo, [{id:"FINISH", title:"✅ Enviar Pedido"}, {id:"BACK_MENU", title:"❌ Cancelar"}]);
}

module.exports = router;
