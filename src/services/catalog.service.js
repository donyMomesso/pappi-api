const ENV = require("../config/env");

async function getCatalogText() {
    const url = "https://integracao.sandbox.cardapioweb.com/api/partner/v1/catalog";
    try {
        const resp = await fetch(url, { 
            headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, "Accept": "application/json" } 
        });
        const data = await resp.json();
        if (!data.categories) return "Cardápio em atualização.";
        
        let menu = "📋 *MENU PAPPI PIZZA:*\n";
        data.categories.forEach(cat => {
            if(cat.status === "ACTIVE") {
                menu += `\n🍕 *${cat.name.toUpperCase()}*\n`;
                cat.items.forEach(item => {
                    if(item.status === "ACTIVE") {
                        menu += `- ${item.name}: R$ ${item.price.toFixed(2)}\n`;
                    }
                });
            }
        });
        return menu;
    } catch (e) { return "Erro ao carregar cardápio."; }
}

module.exports = { getCatalogText };
