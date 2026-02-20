// src/services/cardapioWeb.service.js
const ENV = require("../config/env");

async function createOrder(orderData) {
  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
  const url = `${base}/api/partner/v1/orders`;

  // As duas chaves obrigatórias conforme documentação
  const apiKey = ENV.CARDAPIOWEB_TOKEN; 
  const partnerKey = ENV.CARDAPIOWEB_PARTNER_KEY;

  if (!apiKey || !partnerKey) {
    throw new Error("Chaves de autenticação da Cardápio Web em falta (X-API-KEY ou X-PARTNER-KEY).");
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
        "X-PARTNER-KEY": partnerKey,
      },
      body: JSON.stringify(orderData),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      console.error("❌ Falha ao criar pedido na Cardápio Web:", response.status, data);
      throw new Error(`Erro na API da Cardápio Web: ${response.status} - ${JSON.stringify(data)}`);
    }

    return data;
  } catch (error) {
    console.error("❌ Erro em createOrder (Cardápio Web):", error);
    throw error;
  }
}

module.exports = {
  createOrder,
};
