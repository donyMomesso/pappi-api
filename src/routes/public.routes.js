const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const router = express.Router();
const prisma = new PrismaClient();

const LINK_CARDAPIO = "https://pappipizza.cardapioweb.com";

// ===============================
// IA (Gemini) - modelo via ENV + fallback
// ===============================
function getGeminiModel(preferred) {
  const apiKey = ENV.GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada no Render.");

  const genAI = new GoogleGenerativeAI(apiKey);

  // remove "models/" se alguém colocar
  const modelName = String(preferred || ENV.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");
  return genAI.getGenerativeModel({ model: modelName });
}

async function geminiGenerate(content) {
  const primary = String(ENV.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");
  const fallback = "gemini-2.5-flash"; // existe na sua lista

  try {
    console.log("🤖 Gemini model (primary):", primary);
    const model = getGeminiModel(primary);
    const result = await model.generateContent(content);
    return result.response.text();
  } catch (e) {
    console.error("⚠️ Gemini falhou no primary:", primary, e?.status || e?.message);
    console.log("🤖 Gemini model (fallback):", fallback);
    const model = getGeminiModel(fallback);
    const result = await model.generateContent(content);
    return result.response.text();
  }
}

// ===============================
// HELPERS (WHATSAPP & ÁUDIO)
// ===============================
function digitsOnly(str) {
  return String(str || "").replace(/\D/g, "");
}

async function sendText(to, text) {
  if (!ENV.WHATSAPP_TOKEN || !ENV.WHATSAPP_PHONE_NUMBER_ID) {
    console.error("❌ WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurado.");
    return;
  }

  const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: digitsOnly(to),
      type: "text",
      text: { body: String(text || "").slice(0, 3500) }, // evita textão absurdo
    }),
  }).catch((e) => console.error("❌ Erro WA API:", e));
}

async function downloadAudio(mediaId) {
  try {
    if (!ENV.WHATSAPP_TOKEN) return null;

    const urlResp = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` },
    });

    const meta = await urlResp.json();
    const url = meta?.url;
    if (!url) return null;

    const media = await fetch(url, {
      headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}` },
    });

    const buffer = await media.arrayBuffer();
    return Buffer.from(buffer).toString("base64");
  } catch (e) {
    console.error("❌ downloadAudio erro:", e?.message || e);
    return null;
  }
}

// ===============================
// CONSULTAS API (CARDÁPIO E LOJA)
// ===============================
async function getMenu() {
  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
  const url = `${
