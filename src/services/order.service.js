const ENV = require("../config/env");

async function getOrderHistory(phone) {
    const url = `https://integracao.sandbox.cardapioweb.com/api/partner/v1/orders?phone=${phone}`;
    try {
        const resp = await fetch(url, { 
            headers: { "X-API-KEY": ENV.CARDAPIOWEB_TOKEN, "Accept": "application/json" } 
        });
        const data = await resp.json();
        if (!data || data.length === 0) return "Sem histórico de pedidos.";

        let history = "🕒 *ÚLTIMOS PEDIDOS:*\n";
        data.slice(0, 2).forEach(o => {
            history += `- Pedido #${o.id}: ${o.status} (R$ ${o.total.toFixed(2)})\n`;
        });
        return history;
    } catch (e) { return "Histórico indisponível."; }
}

module.exports = { getOrderHistory };
