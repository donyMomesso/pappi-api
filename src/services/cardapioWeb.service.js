// src/services/cardapioWeb.service.js
const ENV = require("../config/env");

// garante fetch (Node 22 normalmente já tem global.fetch)
const fetch = global.fetch || require("node-fetch");

function cwBase() {
  return ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
}

function cwHeaders() {
  // PADRÃO OFICIAL:
  // X-API-KEY = token do estabelecimento
  // X-PARTNER-KEY = token da integradora
  const apiKey = ENV.CARDAPIOWEB_TOKEN;
  const partnerKey = ENV.CARDAPIOWEB_PARTNER_KEY;

  if (!apiKey) {
    throw new Error("CARDAPIOWEB_TOKEN não configurado (usado como X-API-KEY).");
  }
  if (!partnerKey) {
    throw new Error("CARDAPIOWEB_PARTNER_KEY não configurado (usado como X-PARTNER-KEY).");
  }

  return {
    "X-API-KEY": apiKey,
    "X-PARTNER-KEY": partnerKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

async function createOrder(payload) {
  if (!payload || typeof payload !== "object") {
    const err = new Error("CardapioWeb createOrder: payload inválido (deve ser objeto).");
    err.status = 400;
    throw err;
  }

  const url = `${cwBase()}/api/partner/v1/orders`;
  const resp = await fetch(url, {
    method: "POST",
    headers: cwHeaders(),
    body: JSON.stringify(payload),
  });

  const data = await safeJson(resp);

  if (!resp.ok) {
    const err = new Error(`CardapioWeb createOrder failed: ${resp.status}`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }

  return data;
}

async function getPaymentMethods() {
  const url = `${cwBase()}/api/partner/v1/merchant/payment_methods`;
  const resp = await fetch(url, { headers: cwHeaders() });

  const data = await safeJson(resp);

  // Se der erro, devolve [] mas mantendo logável por quem chamar
  if (!resp.ok) return [];

  // A API pode retornar array direto (como no PDF)
  if (Array.isArray(data)) return data;

  // fallback: caso venha em { data: [...] } (algumas APIs fazem isso)
  if (data && Array.isArray(data.data)) return data.data;

  return [];
}

module.exports = {
  createOrder,
  getPaymentMethods,
};
