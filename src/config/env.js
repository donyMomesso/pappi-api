require("dotenv").config();

function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  // =============================
  // WEBHOOK
  // =============================
  WEBHOOK_VERIFY_TOKEN:
    process.env.WEBHOOK_VERIFY_TOKEN ||
    process.env.WEBHOOK_TOKEN ||
    "",

  // =============================
  // WHATSAPP
  // =============================
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || "",
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  WHATSAPP_WABA_ID: process.env.WHATSAPP_WABA_ID || "",

  // =============================
  // SEGURANÇA INTERNA
  // =============================
  ATTENDANT_API_KEY: process.env.ATTENDANT_API_KEY || "",

  // =============================
  // CARDÁPIO WEB
  // =============================
  CARDAPIOWEB_BASE_URL:
    process.env.CARDAPIOWEB_BASE_URL ||
    "https://integracao.cardapioweb.com",
  CARDAPIOWEB_TOKEN: process.env.CARDAPIOWEB_TOKEN || "",
  CARDAPIOWEB_API_KEY: process.env.CARDAPIOWEB_API_KEY || "",
  CARDAPIOWEB_PARTNER_KEY: process.env.CARDAPIOWEB_PARTNER_KEY || "",

  // =============================
  // GOOGLE MAPS
  // =============================
  GOOGLE_MAPS_API_KEY:
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_MAPS_KEY ||
    "",

  // =============================
  // GEMINI
  // =============================
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: (process.env.GEMINI_MODEL || "gemini-2.5-flash").replace(
    /^models\//,
    ""
  ),

  // =============================
  // BANCO INTER (PIX)
  // =============================
  INTER_CERT_PATH: process.env.INTER_CERT_PATH || "",
  INTER_KEY_PATH: process.env.INTER_KEY_PATH || "",
  INTER_CA_PATH: process.env.INTER_CA_PATH || "",

  INTER_CLIENT_ID: process.env.INTER_CLIENT_ID || "",
  INTER_CLIENT_SECRET: process.env.INTER_CLIENT_SECRET || "",
  INTER_CONTA_CORRENTE: process.env.INTER_CONTA_CORRENTE || "",
  INTER_CHAVE_PIX: process.env.INTER_CHAVE_PIX || "",

  // =============================
  // LOJA
  // =============================
  STORE_LAT: toNumber(process.env.STORE_LAT, null),
  STORE_LNG: toNumber(process.env.STORE_LNG, null),
};
