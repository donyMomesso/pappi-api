const ENV = require("../config/env");

async function getCatalogText() {
    // URL da Sandbox que você forneceu
    const url = "https://integracao.sandbox.cardapioweb.com/api/partner/v1/catalog";
    
    try {
        const resp = await fetch(url, { 
            method: 'GET',
            headers: { 
                "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, 
                "Accept": "application/json" 
            } 
        });
        const data = await resp.json();
        
        // Verifica se existem categorias retornadas
        if (!data.categories || data.categories.length === 0) {
            return "O cardápio está sendo atualizado, mas já te conto nossas especialidades!";
        }
        
        let menuText = "📋 *CARDÁPIO PAPPI PIZZA:*\n";
        
        data.categories.forEach(cat => {
            // Só mostra categorias ativas
            if(cat.status === "ACTIVE") {
                menuText += `\n🍕 *${cat.name.toUpperCase()}*\n`;
                if (cat.items) {
                    cat.items.forEach(item => {
                        // Só mostra itens ativos
                        if(item.status === "ACTIVE") {
                            menuText += `- ${item.name}: R$ ${item.price.toFixed(2)}\n`;
                            if (item.description) menuText += `  _${item.description}_\n`;
                        }
                    });
                }
            }
        });
        
        return menuText;
    } catch (e) {
        console.error("🔥 Erro na conexão com CardápioWeb:", e);
        return "Erro ao carregar o cardápio em tempo real.";
    }
}

module.exports = { getCatalogText };
