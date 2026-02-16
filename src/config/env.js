require("dotenv").config();

const WEBHOOK_VERIFY_TOKEN =
  process.env.WEBHOOK_VERIFY_TOKEN ||
  process.env.WEBHOOK_TOKEN || // fallback se você tiver usado outro nome
  "";

module.exports = {
  WEBHOOK_VERIFY_TOKEN,
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || "",
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  WHATSAPP_WABA_ID: process.env.WHATSAPP_WABA_ID || "",
  ATTENDANT_API_KEY: process.env.ATTENDANT_API_KEY || "",
  CARDAPIOWEB_BASE_URL: process.env.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com",
  CARDAPIOWEB_TOKEN: process.env.CARDAPIOWEB_TOKEN || "",
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY || "",
  STORE_LAT: Number(process.env.STORE_LAT),
  STORE_LNG: Number(process.env.STORE_LNG),
};
