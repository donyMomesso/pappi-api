/**
 * Pappi Pizza API - WhatsApp Cloud + Cardápio Web + Google Maps (Lista de Opções)
 * Versão: ActionsGPT PRO (Humanizada & Validada)
 * Node 18+ (fetch nativo)
 */

const express = require("express");
const app = express();

// Aumentando limite para receber JSON do WhatsApp
app.use(express.json({ limit: "10mb" }));

// ===== 1. CONFIGURAÇÕES E CHAVES =====

// Suas chaves (já configuradas)
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || "AIzaSyBx8S4Rxzj3S74knuSrwnsJqEM1WCDKLj0"; 
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "939101245961363"; 
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ""; // Configure no Render (Environment Variables)
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "pappi_verify_token";

// Configuração Cardápio Web
const CARDAPIOWEB_BASE_URL = "https://integracao.cardapioweb.com";
const CARDAPIOWEB_TOKEN = process.env.CARDAPIOWEB_TOKEN || ""; 

// Configuração da Loja (Pappi Pizza - Campinas)
// Coordenadas aproximadas de Campinas (Centro)
const STORE_LOCATION = { lat: -22.90556, lng: -47.06083 }; 
const MAX_DELIVERY_RADIUS_KM = 12;

// ===== 2. FUNÇÕES ÚTEIS (HELPERS) =====

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function normalizeText(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();
}

// Cálculo de distância simples (Haversine)
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

// ===== 3. INTEGRAÇÕES =====

// --- Google Maps (Retorna Lista de Opções) ---
async function googleGeocode(address) {
  if (!GOOGLE_MAPS_KEY) return [];

  // Se o cliente não digitou "Campinas", forçamos a busca na cidade
  let query = address;
  if (!normalizeText(address).includes("campinas")) {
      query = `${address}, Campinas - SP`;
  }
  
  // Adiciona components=country:BR para garantir Brasil
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:BR&key=${GOOGLE_MAPS_KEY}`;
  
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    
    if (data.status === "OK" && data.results.length > 0) {
      // Retorna até 5 resultados para o cliente escolher
      return data.results.slice(0, 5).map(res => ({
        formatted: res.formatted_address,
        location: res.geometry.location, // { lat, lng }
        placeId: res.place_id
      }));
    }
  } catch (e) {
    console.error("Erro Google Maps:", e);
  }
  return [];
}

// --- Cardápio Web ---
async function getCatalog() {
  if (!CARDAPIOWEB_TOKEN) return null;
  const url = `${CARDAPIOWEB_BASE_URL}/api/partner/v1/catalog`;
  
  try {
    const resp = await fetch(url, {
      headers: { 
        "X-API-KEY": CARDAPIOWEB_TOKEN,
        "Accept": "application/json"
      }
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.error("Erro Cardápio Web:", e);
    return null;
  }
}

// --- WhatsApp Envio ---
async function waSend(to, payload) {
  if (!WHATSAPP_TOKEN) return console.error("Sem WHATSAPP_TOKEN");
  const url = `https://graph.facebook.com/v24.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  
  try {
    const resp = await fetch(url, {
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
    return await resp.json();
  } catch (e) {
    console.error("Erro envio WA:", e);
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
    // Envia uma imagem estática do mapa para confirmação visual
    const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=600x300&maptype=roadmap&markers=color:red%7C${lat},${lng}&key=${GOOGLE_MAPS_KEY}`;
    return waSend(to, {
        type: "image",
        image: { link: mapUrl, caption: caption }
    });
}

// ===== 4. GERENCIAMENTO DE SESSÃO =====
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

// ===== 5. LÓGICA DE CONFIRMAÇÃO DE ENDEREÇO (Auxiliar) =====
async function confirmLocation(from, session, geoData) {
    // Salva o endereço escolhido na sessão definitiva
    session.addressData = geoData;

    // Calcula distância
    const dist = getDistanceFromLatLonInKm(
        STORE_LOCATION.lat, STORE_LOCATION.lng,
        geoData.location.lat, geoData.location.lng
    );

    // Validação de Raio
    if (dist > MAX_DELIVERY_RADIUS_KM) {
        await sendLocationImage(from, geoData.location.lat, geoData.location.lng, "Local encontrado");
        await sendText(from, `⚠️ O endereço *${geoData.formatted}* fica a *${dist.toFixed(1)}km* da loja.\n(Raio de entrega: ${MAX_DELIVERY_RADIUS_KM}km).\nA entrega pode ter taxa extra ou não ser possível.`);
        
        await sendButtons(from, "Deseja continuar?", [
            { id: "ADDR_CONFIRM", title: "Sim, Continuar" },
            { id: "ADDR_RETRY", title: "Não, Corrigir" }
        ]);
    } else {
        await sendLocationImage(from, geoData.location.lat, geoData.location.lng, "Confirme o local");
        await sendText(from, `✅ Localizado: *${geoData.formatted}*\n(Distância: ${dist.toFixed(1)}km)`);
        
        await sendButtons(from, "Este é o local correto?", [
            { id: "ADDR_CONFIRM", title: "Sim, Confirmar" },
            { id: "ADDR_RETRY", title: "Não, Corrigir" }
        ]);
    }
}

// ===== 6. WEBHOOK DO WHATSAPP =====
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
  res.sendStatus(200); // Responde rápido para o Meta

  const body = req.body;
  if (!body.entry) return;

  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value.messages) continue;

      for (const msg of value.messages) {
        const from = msg.from;
        const msgType = msg.type;
        const text = msg.text?.body || "";
        
        // Pega ID de botão ou lista
        const interactiveId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
        const interactiveTitle = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
        
        const session = getSession(from);
        const input = normalizeText(text);

        // --- COMANDOS GERAIS (Reset) ---
        if (input === "menu" || input === "oi" || input === "ola" || interactiveId === "BACK_MENU") {
          resetSession(from);
          await sendText(from, "👋 Olá! Bem-vindo à *Pappi Pizza* 🍕\n\nSou seu assistente virtual. Posso te ajudar a pedir pizza, consultar cardápio ou falar com um humano.");
          await sendButtons(from, "Como deseja prosseguir?", [
            { id: "BTN_PEDIR", title: "🛒 Fazer Pedido" },
            { id: "BTN_CARDAPIO", title: "📖 Ver Cardápio" },
            { id: "BTN_HUMANO", title: "👨‍🍳 Falar c/ Humano" }
          ]);
          continue;
        }

        // --- FLUXO: INÍCIO ---
        if (interactiveId === "BTN_PEDIR") {
          session.step = "ORDER_TYPE";
          await sendButtons(from, "Para começar: É entrega ou retirada?", [
            { id: "TYPE_DELIVERY", title: "🛵 Entrega" },
            { id: "TYPE_TAKEOUT", title: "🏃 Retirada" }
          ]);
          continue;
        }

        if (interactiveId === "BTN_CARDAPIO") {
          await sendText(from, "Acesse nosso cardápio completo com fotos aqui:\nhttps://app.cardapioweb.com/pappi_pizza?s=dony");
          await sendButtons(from, "Quer fazer o pedido por aqui agora?", [
             { id: "BTN_PEDIR", title: "Sim, Fazer Pedido" },
             { id: "BACK_MENU", title: "Voltar ao Início" }
          ]);
          continue;
        }

        if (interactiveId === "BTN_HUMANO") {
           await sendText(from, "👨‍🍳 Um atendente humano vai te responder em instantes! Aguarde um pouquinho.");
           continue;
        }

        // --- FLUXO: TIPO DE PEDIDO ---
        if (interactiveId === "TYPE_DELIVERY") {
          session.orderType = "delivery";
          session.step = "ASK_ADDRESS";
          await sendText(from, "📍 *Entrega*\nPor favor, digite seu endereço completo (Rua, Número e Bairro).\n\n_Ex: Rua Rodolfo Gortadello, 35, Jardim Bandeira II_");
          continue;
        }

        if (interactiveId === "TYPE_TAKEOUT") {
          session.orderType = "takeout";
          session.step = "SELECT_CATEGORY";
          await startCatalogFlow(from); // Pula validação de endereço
          continue;
        }

        // --- FLUXO: VALIDAÇÃO DE ENDEREÇO (GOOGLE MAPS) ---
        if (session.step === "ASK_ADDRESS" && !interactiveId) {
            // 1. Validação básica de tamanho (evita "oi", ".", "rua 1")
            if (input.length < 5) {
                await sendText(from, "❌ Endereço muito curto ou inválido.\nPor favor, digite: *Rua, Número e Bairro*.");
                return;
            }

            await sendText(from, "🔎 Pesquisando endereços...");
            
            // Busca LISTA de endereços
            const results = await googleGeocode(text);
            
            // 2. Se o Google não achou nada
            if (results.length === 0) {
                await sendText(from, "❌ Não consegui localizar esse endereço.\nTente digitar mais completo:\n*Ex: Rua das Flores, 123, Jardim Bandeira*");
                return;
            }

            // 3. SE ACHOU SÓ UM: Vai direto para confirmação
            if (results.length === 1) {
                await confirmLocation(from, session, results[0]);
                return;
            }

            // 4. SE ACHOU VÁRIOS: Manda Lista para escolher
            session.candidateAddresses = results; // Salva opções
            
            const rows = results.map((addr, index) => ({
                id: `ADDR_OPT_${index}`, 
                title: (addr.formatted.split(",")[0] || "Opção").slice(0, 23), // Título curto
                description: addr.formatted.slice(0, 70) // Descrição longa
            }));

            await sendList(from, "Encontrei alguns endereços. Qual deles é o seu?", "Selecionar Local", [{ title: "Opções Encontradas", rows }]);
            return;
        }

        // --- RESPOSTA DA LISTA DE ENDEREÇOS ---
        if (interactiveId && interactiveId.startsWith("ADDR_OPT_")) {
            const index = parseInt(interactiveId.replace("ADDR_OPT_", ""));
            const chosenAddr = session.candidateAddresses ? session.candidateAddresses[index] : null;

            if (!chosenAddr) {
                await sendText(from, "Erro ao selecionar. Digite o endereço novamente.");
                session.step = "ASK_ADDRESS";
                return;
            }

            await confirmLocation(from, session, chosenAddr);
            return;
        }

        // --- CONFIRMAÇÃO FINAL DO ENDEREÇO ---
        if (interactiveId === "ADDR_RETRY") {
            session.step = "ASK_ADDRESS";
            await sendText(from, "Tudo bem! Digite o endereço novamente (Rua, Número e Bairro):");
            continue;
        }

        if (interactiveId === "ADDR_CONFIRM") {
            session.step = "SELECT_CATEGORY";
            await sendText(from, "Perfeito! Endereço anotado! 📝");
            await startCatalogFlow(from);
            continue;
        }

        // --- FLUXO: CATÁLOGO (CATEGORIAS) ---
        
        // --- SELEÇÃO DE ITEM/SABOR ---
        if (interactiveId && interactiveId.startsWith("CAT_")) {
            // O usuário escolheu uma categoria (ex: Pizzas ou Bebidas)
            const catId = interactiveId.replace("CAT_", "");
            await showItemsFromCategory(from, catId);
            continue;
        }

        // --- SELEÇÃO DE TAMANHO (Consciência) ---
        if (interactiveId && interactiveId.startsWith("ITEM_")) {
            // O usuário escolheu uma Pizza Específica (ex: Calabresa)
            const itemId = interactiveId.replace("ITEM_", "");
            session.selectedItemId = itemId;
            session.selectedItemName = interactiveTitle;

            // Se for bebida ou item sem tamanho variável, pula pra resumo
            // AQUI entra a "consciência" dos tamanhos de pizza
            if (session.selectedCategoryName && session.selectedCategoryName.toLowerCase().includes("pizza")) {
                session.step = "SELECT_SIZE";
                await sendText(from, `🍕 Ótima escolha: *${interactiveTitle}*!`);
                await sendText(from, "Sobre os tamanhos:\n\n🟢 *Brotinho* (4 pedaços) - Individual\n🟡 *Grande* (8 pedaços) - Padrão para 2-3 pessoas\n🔴 *Gigante* (16 pedaços) - Para família toda!");
                
                await sendButtons(from, "Qual tamanho você prefere?", [
                    { id: "SIZE_BROTO", title: "Brotinho (4)" },
                    { id: "SIZE_GRANDE", title: "Grande (8)" },
                    { id: "SIZE_GIGANTE", title: "Gigante (16)" }
                ]);
            } else {
                // Se não for pizza (ex: Bebida), confirma direto
                session.selectedSize = "Padrão";
                await confirmOrder(from, session);
            }
            continue;
        }

        if (interactiveId && interactiveId.startsWith("SIZE_")) {
            session.selectedSize = interactiveTitle; // Ex: "Grande (8)"
            await confirmOrder(from, session);
            continue;
        }

        // --- FINALIZAÇÃO ---
        if (interactiveId === "FINISH_ORDER") {
            const totalEstimado = "A calcular"; // Aqui você somaria preços se tivesse puxado do JSON
            const linkCheckout = `https://wa.me/5519982275105?text=${encodeURIComponent(`Olá, gostaria de finalizar meu pedido:\n- ${session.selectedItemName}\n- Tamanho: ${session.selectedSize}\n- Tipo: ${session.orderType}\n(Endereço validado no sistema)`)}`;
            
            await sendText(from, `🥳 Pedido Enviado para a Cozinha!\n\nUm atendente vai confirmar o valor total e o tempo de entrega.\n\nSe quiser falar direto, clique aqui: ${linkCheckout}`);
            resetSession(from);
            continue;
        }

        // Fallback para texto solto não entendido (só se não estiver esperando endereço)
        if (!interactiveId && session.step !== "ASK_ADDRESS") {
             await sendText(from, "Não entendi sua resposta. Por favor, use os botões ou digite 'menu' para reiniciar.");
        }
      }
    }
  }
});

// ===== 7. LÓGICA DO CATÁLOGO AUXILIAR =====

async function startCatalogFlow(from) {
    const catalog = await getCatalog();
    if (!catalog) {
        await sendText(from, "Desculpe, sistema de cardápio está instável. Digite o nome da pizza que você quer:");
        return;
    }

    // Filtrar categorias principais
    const categories = catalog.categories || [];
    const sections = [{
        title: "Categorias",
        rows: categories.slice(0, 10).map(c => ({
            id: `CAT_${c.id}`,
            title: c.name,
            description: "Clique para ver sabores"
        }))
    }];

    await sendList(from, "O que você gostaria de pedir hoje?", "Ver Cardápio", sections);
}

async function showItemsFromCategory(from, catId) {
    const catalog = await getCatalog();
    const category = catalog.categories.find(c => String(c.id) === String(catId));
    
    if (!category) return sendText(from, "Categoria não encontrada.");

    // Salva o nome da categoria na sessão para saber se pergunta tamanho depois
    const session = getSession(from);
    session.selectedCategoryName = category.name;

    const items = category.items || [];
    
    // Limite do WhatsApp é 10 linhas por seção. Vamos pegar as primeiras 10.
    const rows = items.slice(0, 10).map(item => ({
        id: `ITEM_${item.id}`,
        title: item.name,
        description: item.description ? item.description.slice(0, 60) : `R$ ${item.price}`
    }));

    await sendList(from, `Sabores de ${category.name}`, "Escolher Sabor", [{ title: "Sabores", rows }]);
}

async function confirmOrder(from, session) {
    const endereco = session.orderType === "delivery" && session.addressData 
        ? session.addressData.formatted 
        : "Retirada no Balcão";

    const resumo = `📝 *Resumo do Pedido*\n\n🍕 Item: *${session.selectedItemName}*\n📏 Tamanho: *${session.selectedSize}*\n🛵 Tipo: *${session.orderType === 'delivery' ? 'Entrega' : 'Retirada'}*\n📍 Local: ${endereco}\n\nConfirma o pedido?`;

    await sendButtons(from, resumo, [
        { id: "FINISH_ORDER", title: "✅ Confirmar" },
        { id: "BACK_MENU", title: "❌ Cancelar" }
    ]);
}

// ===== 8. ROTAS PÚBLICAS (Health Check) =====
app.get("/health", (req, res) => {
  res.json({ 
      status: "online", 
      store: "Pappi Pizza", 
      time: new Date().toISOString(),
      maps: Boolean(GOOGLE_MAPS_KEY)
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🔥 Pappi API PRO rodando na porta ${PORT}`));
