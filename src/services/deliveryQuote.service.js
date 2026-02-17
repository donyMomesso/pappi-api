const ENV = require("../config/env");
const maps = require("./maps"); // usa o seu service existente

// limites
const MAX_KM = Number(process.env.DELIVERY_MAX_KM || 12); // 12km padrão
const SOFT_KM = Number(process.env.DELIVERY_SOFT_KM || 10); // 10km "ideal"

function hasEnoughAddress(text) {
  const t = String(text || "").toLowerCase();
  const hasStreet = /(rua|av|avenida|travessa|alameda|praça|praca|rodovia|estrada)/i.test(t);
  const hasNumber = /\b\d{1,5}\b/.test(t);
  const hasBairro = /bairro/i.test(t) || /jd|jardim|vila|vl|parque|pq/i.test(t);
  return hasStreet && hasNumber && hasBairro;
}

async function quoteDeliveryIfPossible({ addressText }) {
  // se não tem google maps key, não tenta
  if (!ENV.GOOGLE_MAPS_API_KEY) return { ok: false, reason: "NO_KEY" };

  // se não tem endereço completo, não tenta
  if (!hasEnoughAddress(addressText)) return { ok: false, reason: "INCOMPLETE_ADDRESS" };

  // usa o seu maps.geocodeCandidates para achar destino
  const candidates = await maps.geocodeCandidates(addressText);
  const best = Array.isArray(candidates) ? candidates[0] : null;
  if (!best?.location) return { ok: false, reason: "NOT_FOUND" };

  // usa coords da loja já no ENV
  const origin = { lat: ENV.STORE_LAT, lng: ENV.STORE_LNG };
  const dest = best.location;

  // usa o seu maps.quote (km/eta/frete)
  const q = await maps.quote(origin, dest); 
  // esperamos algo como { km, etaMin, fee, ... } (ajuste se seu maps.js usar nomes diferentes)

  const km = Number(q?.km);
  if (!Number.isFinite(km)) return { ok: false, reason: "NO_KM" };

  const within = km <= MAX_KM;
  const soft = km <= SOFT_KM;

  return {
    ok: true,
    within,
    soft,
    km,
    etaMin: q?.etaMin ?? q?.eta ?? null,
    fee: q?.fee ?? q?.frete ?? null,
    formatted: best.formatted_address || best.formatted || addressText,
  };
}

module.exports = { quoteDeliveryIfPossible };
