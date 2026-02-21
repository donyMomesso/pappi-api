// src/services/cardapioWeb.service.js
const ENV = require("../config/env");

// Node 18+ tem fetch; fallback pra node-fetch se rodar em ambiente antigo
const fetchImpl = global.fetch || require("node-fetch");

/**
 * Pequeno wrapper com timeout para evitar requests presos
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function cwBase() {
  return (ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com").replace(/\/$/, "");
}

/**
 * Headers oficiais (dupla autenticação) para endpoints /api/partner/*
 */
function cwHeadersPartner() {
  const apiKey = ENV.CARDAPIOWEB_API_KEY || ENV.CARDAPIOWEB_TOKEN;
  const partnerKey = ENV.CARDAPIOWEB_PARTNER_KEY;

  if (!apiKey) throw new Error("CARDAPIOWEB_API_KEY (ou CARDAPIOWEB_TOKEN) não configurado.");
  if (!partnerKey) throw new Error("CARDAPIOWEB_PARTNER_KEY não configurado.");

  return {
    "X-API-KEY": apiKey,
    "X-PARTNER-KEY": partnerKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Em alguns ambientes, o catálogo pode aceitar apenas X-API-KEY.
 * Mantemos separado para fallback.
 */
function cwHeadersApiKeyOnly() {
  const apiKey = ENV.CARDAPIOWEB_API_KEY || ENV.CARDAPIOWEB_TOKEN;
  if (!apiKey) throw new Error("CARDAPIOWEB_API_KEY (ou CARDAPIOWEB_TOKEN) não configurado.");
  return { "X-API-KEY": apiKey, Accept: "application/json" };
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
  const resp = await fetchWithTimeout(
    url,
    { method: "POST", headers: cwHeadersPartner(), body: JSON.stringify(payload) },
    20000
  );

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
  const resp = await fetchWithTimeout(url, { headers: cwHeadersPartner() }, 15000);
  const data = await safeJson(resp);

  if (!resp.ok) return [];
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

/**
 * Catálogo (tenta dupla autenticação e, se falhar, cai para API-KEY only)
 * Retorna o JSON bruto.
 */
async function getCatalogRaw() {
  const base = cwBase();
  const candidates = [
    { url: `${base}/api/partner/v1/catalog`, headers: () => cwHeadersPartner() },
    { url: `${base}/api/partner/v1/catalog`, headers: () => cwHeadersApiKeyOnly() },
  ];

  let lastErr = null;
  for (const c of candidates) {
    try {
      const resp = await fetchWithTimeout(c.url, { headers: c.headers() }, 20000);
      const data = await safeJson(resp);
      if (resp.ok && data) return data;
      lastErr = { status: resp.status, data };
    } catch (e) {
      lastErr = e;
    }
  }
  const err = new Error("CardapioWeb getCatalogRaw failed");
  err.data = lastErr;
  throw err;
}

module.exports = {
  createOrder,
  getPaymentMethods,
  getCatalogRaw,
};
