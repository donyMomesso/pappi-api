const ENV = require("../config/env");
const maps = require("./maps.service");

// limites (mas quem manda mesmo é a taxa do maps: acima de 10km fica null)
const MAX_KM = Number(process.env.DELIVERY_MAX_KM || 12);
const SOFT_KM = Number(process.env.DELIVERY_SOFT_KM || 10);

// heurística simples pra não gastar request do Google com endereço ruim
function hasEnoughAddress(text) {
  const t = String(text || "").toLowerCase();
  const hasStreet = /(rua|av|avenida|travessa|alameda|praça|praca|rodovia|estrada)/i.test(t);
  const hasNumber = /\b\d{1,5}\b/.test(t);
  const hasBairro = /bairro/i.test(t) || /jd|jardim|vila|vl|parque|pq/i.test(t);
  return hasStreet && hasNumber && hasBairro;
}

async function quoteDeliveryIfPossible({ addressText }) {
  if (!ENV.GOOGLE_MAPS_API_KEY) return { ok: false, reason: "NO_KEY" };
  if (!Number.isFinite(ENV.STORE_LAT) || !Number.isFinite(ENV.STORE_LNG))
    return { ok: false, reason: "NO_STORE_COORDS" };
  if (!hasEnoughAddress(addressText)) return { ok: false, reason: "INCOMPLETE_ADDRESS" };

  try {
    const q = await maps.quoteByAddress(addressText);
    const km = Number(q?.km);
    if (!Number.isFinite(km)) return { ok: false, reason: "NO_KM" };

    const within = q?.is_serviceable === true; // ✅ regra real: taxa existe
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
    return { ok: false, reason: "QUOTE_FAILED" };
  }
}

module.exports = { quoteDeliveryIfPossible, MAX_KM };
