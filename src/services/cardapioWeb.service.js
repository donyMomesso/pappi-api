// src/services/cardapioWeb.service.js
const ENV = require("../config/env");

function cwBase() {
  return ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
}

function cwHeaders() {
  const apiKey = ENV.CARDAPIOWEB_API_KEY || ENV.CARDAPIOWEB_TOKEN; // compat
  const partnerKey = ENV.CARDAPIOWEB_PARTNER_KEY;

  if (!apiKey) throw new Error("CARDAPIOWEB_API_KEY (ou CARDAPIOWEB_TOKEN) não configurada");
  if (!partnerKey) throw new Error("CARDAPIOWEB_PARTNER_KEY não configurada");

  return {
    "X-API-KEY": apiKey,
    "X-PARTNER-KEY": partnerKey,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

async function createOrder(payload) {
  const url = `${cwBase()}/api/partner/v1/orders`;
  const resp = await fetch(url, {
    method: "POST",
    headers: cwHeaders(),
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));

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
  const data = await resp.json().catch(() => null);
  if (!resp.ok) return [];
  return Array.isArray(data) ? data : [];
}

module.exports = { createOrder, getPaymentMethods };
