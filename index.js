/**
 * Pappi Pizza API - WhatsApp Cloud + Cardápio Web + Google Maps
 * Versão: ActionsGPT PRO (Com Cardápio de Backup)
 * Node 18+ (fetch nativo)
 */

const express = require("express");
const app = express();

app.use(express.json({ limit: "10mb" }));

// ===== 1. CONFIGURAÇÕES =====

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || "AIzaSyBx8S4Rxzj3S74knuSrwnsJqEM1WCDKLj0"; 
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "939101245961363"; 
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ""; 
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "pappi_verify_token";

const CARDAPIOWEB_BASE_URL = "https://integracao.cardapioweb.com";
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN || ""; 

const STORE_LOCATION = { lat: -22.90556, lng: -47.06083 }; 
const MAX_DELIVERY_RADIUS_KM = 12;

// ===== CARDÁPIO DE BACKUP (Para quando a API falhar) =====
const FALLBACK_CATALOG = {
    categories: [
        {
            id: "cat_pizzas",
            name: "🍕 Pizzas Salgadas",
            items: [
                { id: "2991", name: "Calabresa", description: "Clássica com cebola e azeitonas", price: 30.00 },
                { id: "2992", name: "Frango c/ Catupiry", description: "Frango desfiado e catupiry original", price: 35.00 },
                { id: "2988", name: "Margherita", description: "Molho, mussarela, tomate e manjericão", price: 32.00 },
                { id: "2995", name: "Portuguesa", description: "Presunto, ovos, cebola e ervilha", price: 34.00 },
                { id: "3010", name: "À Moda da Casa", description: "Especialidade do Pappi", price: 40.00 }
            ]
        },
        {
            id: "cat_bebidas",
            name: "🥤 Bebidas",
            items: [
                { id: "3006", name: "Coca-Cola 2L", description: "Garrafa 2 Litros", price: 14.00 },
                { id: "3005", name: "Guaraná 2L", description: "Garrafa 2 Litros", price: 12.00 },
                { id: "3007", name: "Heineken Long Neck", description: "Cerveja 330ml", price: 10.00 }
            ]
        }
    ]
};

// ===== 2. HELPERS =====

function digitsOnly(s) { return String(s || "").replace(/\D/g, ""); }
function normalizeText(s) { return (s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim(); }

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const R = 6371; 
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
function deg2rad(deg) { return deg * (Math.PI / 180); }

// ===== 3. INTEGRAÇÕES =====

async function googleGeocode(address) {
  if (!GOOGLE_MAPS_KEY) return [];
  let query = address;
  if (!normalizeText(address).includes("campinas")) query = `${address}, Campinas - SP`;
  
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:BR&key=${GOOGLE_MAPS_KEY}`;
  
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
  } catch (e) { console.error("Erro Google Maps:", e); }
  return [];
}

// --- Cardápio Web (Com log de erro) ---
async function getCatalog() {
  if (!CARDAPIOWEB_TOKEN) {
      console.log("⚠️ Sem token Cardápio Web, usando Backup.");
      return FALLBACK_CATALOG;
  }
  
  const url = `${CARDAPIOWEB_BASE_URL}/api/partner/v1/catalog`;
  try {
    const resp = await fetch(url, { headers: { "X-API-KEY": CARDAPIOWEB_TOKEN, "Accept": "application/json" } });
    if (!resp.ok) throw new Error(`Status ${resp.status}`);
    const data = await resp.json();
    // Validação básica se veio vazio
    if (!data.categories || data.categories.length === 0) throw new Error("Catalogo vazio");
    return data;
  } catch (e) {
    console.error("❌ Erro API Cardápio Web (Usando Backup):", e.message);
    return FALLBACK_CATALOG; // Retorna o backup se der erro
  }
}

async function waSend(to, payload) {
  if (!WHATSAPP_TOKEN) return console.error("Sem WHATSAPP_TOKEN");
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

// ===== 4. SESSÃO =====
const sessions = new Map();
function getSession(from) { if (!sessions.has(from)) sessions.set(from, { step: "MENU" }); return sessions.get(from); }
function resetSession(from) { sessions.set(from, { step: "MENU" }); }

// ===== 5. LÓGICA DE CONFIRMAÇÃO DE ENDEREÇO =====
async function confirmLocation(from, session, geoData) {
    session.addressData = geoData;
    const dist = getDistanceFromLatLonInKm(STORE_LOCATION.lat, STORE_LOCATION.lng, geoData.location.lat, geoData.location.lng);

    if (dist > MAX_DELIVERY_RADIUS_KM) {
        await sendLocationImage(from, geoData.location.lat, geoData.location.lng, "Local encontrado");
        await sendText(from, `⚠️ Endereço a *${dist.toFixed(1)}km* da loja.\n(Raio: ${MAX_DELIVERY_RADIUS_KM}km). Pode haver taxa extra.`);
        await sendButtons(from, "Deseja continuar?", [{ id: "ADDR_CONFIRM", title: "Sim, Continuar" }, { id: "ADDR_RETRY", title: "Não, Corrigir" }]);
    } else {
        await sendLocationImage(from, geoData.location.lat, geoData.location.lng, "Confirme o local");
        await sendText(from, `✅ Localizado: *${geoData.formatted}*\n(Distância: ${dist.toFixed(1)}km)`);
        await sendButtons(from, "Este é o local correto?", [{ id: "ADDR_CONFIRM", title: "Sim, Confirmar" }, { id: "ADDR_RETRY", title: "Não, Corrigir" }]);
    }
}

// ===== 6. WEBHOOK =====
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
        const interactiveId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
        const interactiveTitle = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
        
        const session = getSession(from);
        const input = normalizeText(text);

        // --- RESET ---
        if (input === "menu" || input === "oi" || input === "ola" || interactiveId === "BACK_MENU") {
          resetSession(from);
          await sendText(from, "👋 Olá! Bem-vindo à *Pappi Pizza* 🍕\nPosso te ajudar a pedir pizza ou consultar o cardápio.");
          await sendButtons(from, "Como deseja prosseguir?", [{ id: "BTN_PEDIR", title: "🛒 Fazer Pedido" }, { id: "BTN_CARDAPIO", title: "📖 Ver Cardápio" }, { id: "BTN_HUMANO", title: "👨‍🍳 Atendente" }]);
          continue;
        }

        if (interactiveId === "BTN_PEDIR") {
          session.step = "ORDER_TYPE";
          await sendButtons(from, "É entrega ou retirada?", [{ id: "TYPE_DELIVERY", title: "🛵 Entrega" }, { id: "TYPE_TAKEOUT", title: "🏃 Retirada" }]);
          continue;
        }

        if (interactiveId === "BTN_CARDAPIO") {
          await sendText(from, "Cardápio completo: https://app.cardapioweb.com/pappi_pizza?s=dony");
          await sendButtons(from, "Quer pedir agora?", [{ id: "BTN_PEDIR", title: "Sim, Pedir" }, { id: "BACK_MENU", title: "Voltar" }]);
          continue;
        }

        if (interactiveId === "BTN_HUMANO") {
           await sendText(from, "👨‍🍳 Um atendente humano vai te responder em instantes! Aguarde.");
           continue;
        }

        // --- TIPO DE PEDIDO ---
        if (interactiveId === "TYPE_DELIVERY") {
          session.orderType = "delivery";
          session.step = "ASK_ADDRESS";
          await sendText(from, "📍 *Entrega*\nDigite seu endereço (Rua, Número e Bairro).");
          continue;
        }

        if (interactiveId === "TYPE_TAKEOUT") {
          session.orderType = "takeout";
          session.step = "SELECT_CATEGORY";
          await startCatalogFlow(from);
          continue;
        }

        // --- ENDEREÇO ---
        if (session.step === "ASK_ADDRESS" && !interactiveId) {
            if (input.length < 5) { await sendText(from, "❌ Endereço muito curto. Digite Rua, Número e Bairro."); return; }
            await sendText(from, "🔎 Pesquisando...");
            const results = await googleGeocode(text);
            
            if (results.length === 0) { await sendText(from, "❌ Não encontrei. Tente digitar: Rua X, 123, Bairro Y"); return; }
            if (results.length === 1) { await confirmLocation(from, session, results[0]); return; }

            session.candidateAddresses = results;
            const rows = results.map((addr, index) => ({ id: `ADDR_OPT_${index}`, title: (addr.formatted.split(",")[0] || "Opção").slice(0, 23), description: addr.formatted.slice(0, 70) }));
            await sendList(from, "Selecione o endereço correto:", "Endereços", [{ title: "Opções", rows }]);
            return;
        }

        if (interactiveId && interactiveId.startsWith("ADDR_OPT_")) {
            const index = parseInt(interactiveId.replace("ADDR_OPT_", ""));
            const chosenAddr = session.candidateAddresses ? session.candidateAddresses[index] : null;
            if (chosenAddr) await confirmLocation(from, session, chosenAddr);
            else await sendText(from, "Erro. Digite novamente.");
            return;
        }

        if (interactiveId === "ADDR_RETRY") { session.step = "ASK_ADDRESS"; await sendText(from, "Digite o endereço novamente:"); continue; }
        if (interactiveId === "ADDR_CONFIRM") {
            session.step = "SELECT_CATEGORY";
            await sendText(from, "Endereço salvo! Vamos ao pedido. 🍕");
            await startCatalogFlow(from);
            continue;
        }

        // --- CARDÁPIO ---
        if (interactiveId && interactiveId.startsWith("CAT_")) {
            const catId = interactiveId.replace("CAT_", "");
            await showItemsFromCategory(from, catId);
            continue;
        }

        if (interactiveId && interactiveId.startsWith("ITEM_")) {
            const itemId = interactiveId.replace("ITEM_", "");
            session.selectedItemId = itemId;
            session.selectedItemName = interactiveTitle;

            if (session.selectedCategoryName && session.selectedCategoryName.toLowerCase().includes("pizza")) {
                session.step = "SELECT_SIZE";
                await sendText(from, `🍕 Sabor: *${interactiveTitle}*`);
                await sendButtons(from, "Escolha o tamanho:", [{ id: "SIZE_BROTO", title: "Brotinho (4)" }, { id: "SIZE_GRANDE", title: "Grande (8)" }, { id: "SIZE_GIGANTE", title: "Gigante (16)" }]);
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
            const linkCheckout = `https://wa.me/5519982275105?text=${encodeURIComponent(`Novo Pedido:\nItem: ${session.selectedItemName}\nTamanho: ${session.selectedSize}\nTipo: ${session.orderType}\nEndereço: ${session.addressData?.formatted || 'Retirada'}`)}`;
            await sendText(from, `✅ Pedido Enviado!\n\nUm atendente vai confirmar o total.\nLink para finalizar: ${linkCheckout}`);
            resetSession(from);
            continue;
        }
      }
    }
  }
});

// --- FUNÇÕES CARDÁPIO ---
async function startCatalogFlow(from) {
    const catalog = await getCatalog();
    const categories = catalog.categories || [];
    const sections = [{ title: "Categorias", rows: categories.slice(0, 10).map(c => ({ id: `CAT_${c.id}`, title: c.name, description: "Ver opções" })) }];
    await sendList(from, "O que deseja pedir?", "Cardápio", sections);
}

async function showItemsFromCategory(from, catId) {
    const catalog = await getCatalog();
    const category = catalog.categories.find(c => String(c.id) === String(catId));
    if (!category) return sendText(from, "Categoria não encontrada.");
    
    getSession(from).selectedCategoryName = category.name;
    const items = category.items || [];
    const rows = items.slice(0, 10).map(item => ({ id: `ITEM_${item.id}`, title: item.name, description: `R$ ${item.price}` }));
    await sendList(from, `Opções de ${category.name}`, "Selecionar", [{ title: "Itens", rows }]);
}

async function confirmOrder(from, session) {
    const endereco = session.orderType === "delivery" && session.addressData ? session.addressData.formatted : "Retirada";
    const resumo = `📝 *Resumo*\n🍕 ${session.selectedItemName}\n📏 ${session.selectedSize}\n📍 ${endereco}`;
    await sendButtons(from, resumo, [{ id: "FINISH_ORDER", title: "✅ Confirmar" }, { id: "BACK_MENU", title: "❌ Cancelar" }]);
}

// ===== 7. SERVER =====
app.get("/health", (req, res) => res.json({ status: "online", store: "Pappi Pizza" }));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🔥 Pappi API rodando na porta ${PORT}`));
