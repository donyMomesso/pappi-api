// src/services/deliveryQuote.service.js
const ENV = require("../config/env");
const maps = require("./maps.service");

const MAX_KM = Number(process.env.DELIVERY_MAX_KM || 12);
const SOFT_KM = Number(process.env.DELIVERY_SOFT_KM || 10);

function digitsOnly(str) {
  return String(str || "").replace(/\D/g, "");
}

// ✅ aceita CEP (8 dígitos) OU rua com número
function hasEnoughAddress(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;

  const d = digitsOnly(raw);
  if (d.length === 8) return true; // CEP

  const t = raw.toLowerCase();
  const hasText = t.length > 5;
  const hasNumber = /\b\d{1,5}\b/.test(t);
  return hasText && hasNumber;
}

async function quoteDeliveryIfPossible(addressText) {
  if (!ENV.GOOGLE_MAPS_API_KEY) return { ok: false, reason: "NO_KEY" };
  if (!hasEnoughAddress(addressText)) return { ok: false, reason: "INCOMPLETE_ADDRESS" };

  try {
    const q = await maps.quoteByAddress(addressText);
    const km = Number(q?.km);

    if (!Number.isFinite(km)) return { ok: false, reason: "NO_KM" };

    const within = q?.is_serviceable === true;
    const soft = km <= SOFT_KM;

    return {
      ok: true,
      within,
      soft,
      km,
      etaMin: q?.eta_minutes ?? null,
      fee: q?.delivery_fee ?? null,
      formatted: q?.formatted_address || addressText,
      service_limit_km_hint: MAX_KM,
    };
  } catch (e) {
    console.error("❌ Erro no cálculo de entrega:", e?.message || e);
    return { ok: false, reason: "QUOTE_FAILED" };
  }
}

module.exports = { quoteDeliveryIfPossible, MAX_KM };
