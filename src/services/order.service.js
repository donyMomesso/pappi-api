const ENV = require("../config/env");

async function changeOrderStatus(orderId, action) {
    // URL de Produção conforme a documentação que você enviou
    const url = `https://integracao.cardapioweb.com/api/partner/v1/orders/${orderId}/${action}`;
    
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "X-API-KEY": ENV.CARDAPIOWEB_TOKEN,
                "Accept": "application/json",
                "Content-Type": "application/json"
            }
        });

        // O CardápioWeb retorna 204 quando dá tudo certo
        if (response.status === 204) {
            return { ok: true };
        }
        
        const errorData = await response.json();
        return { ok: false, error: errorData.message || "Erro desconhecido" };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = { changeOrderStatus };
