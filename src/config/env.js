require("dotenv").config();

const WEBHOOK_VERIFY_TOKEN =
  process.env.WEBHOOK_VERIFY_TOKEN ||
  process.env.WEBHOOK_TOKEN ||
  "";

function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  // Webhook
  WEBHOOK_VERIFY_TOKEN,

  // WhatsApp Cloud API (Meta)
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || "",
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  WHATSAPP_WABA_ID: process.env.WHATSAPP_WABA_ID || "",

  // Segurança interna
  ATTENDANT_API_KEY: process.env.ATTENDANT_API_KEY || "",

  // CardápioWeb (produção por padrão)
  CARDAPIOWEB_BASE_URL:
    process.env.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com",
  CARDAPIOWEB_TOKEN: process.env.CARDAPIOWEB_TOKEN || "",

  // Google Maps
  GOOGLE_MAPS_API_KEY:
    process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY || "",

  // Gemini (Google AI Studio)
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: (process.env.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, ""),

  // Loja (se não setar, fica null)
  STORE_LAT: toNumber(process.env.STORE_LAT, null),
  STORE_LNG: toNumber(process.env.STORE_LNG, null),
};
