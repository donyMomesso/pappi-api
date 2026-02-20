// src/services/maps.service.js
const ENV = require("../config/env");

function calcDeliveryFeeKm(km) {
  if (km <= 2) return 5;
  if (km <= 3) return 8;
  if (km <= 6) return 12;
  if (km <= 10) return 15;
  return null;
}

async function fetchJsonWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    const data = await resp.json().catch(() => null);
    return { ok: resp.ok, status: resp.status, data };
  } finally {
    clearTimeout(t);
  }
}

async function quoteByAddress(address) {
  const key = ENV.GOOGLE_MAPS_API_KEY;

  // ✅ parse robusto (Render env vem string)
  const storeLat = Number.parseFloat(String(ENV.STORE_LAT || ""));
  const storeLng = Number.parseFloat(String(ENV.STORE_LNG || ""));

  if (!key) throw new Error("missing_google_maps_key");
  if (!Number.isFinite(storeLat) || !Number.isFinite(storeLng)) throw new Error("missing_store_lat_lng");

  // 1) Geocode
  const geoUrl = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  geoUrl.searchParams.set("address", address);
  geoUrl.searchParams.set("key", key);
  geoUrl.searchParams.set("language", "pt-BR");

  const geoRes = await fetchJsonWithTimeout(geoUrl, 8000);
  const geo = geoRes.data;

  if (geo?.status !== "OK" || !geo.results?.[0]) throw new Error("geocode_failed");

  const loc = geo.results[0].geometry.location;
  const formatted = geo.results[0].formatted_address;

  // 2) Distance Matrix
  const dmUrl = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  dmUrl.searchParams.set("origins", `${storeLat},${storeLng}`);
  dmUrl.searchParams.set("destinations", `${loc.lat},${loc.lng}`);
  dmUrl.searchParams.set("mode", "driving");
  dmUrl.searchParams.set("key", key);
  dmUrl.searchParams.set("language", "pt-BR");

  const dmRes = await fetchJsonWithTimeout(dmUrl, 8000);
  const dm = dmRes.data;

  const el = dm?.rows?.[0]?.elements?.[0];
  if (!el || el.status !== "OK") throw new Error("distance_matrix_failed");

  const km = Math.round((el.distance.value / 1000) * 10) / 10;
  const eta = Math.round(el.duration.value / 60);
  const fee = calcDeliveryFeeKm(km);

  return {
    formatted_address: formatted,
    km,
    eta_minutes: eta,
    delivery_fee: fee,
    is_serviceable: fee !== null,
  };
}

async function reverseGeocode(lat, lng) {
  const key = ENV.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("missing_google_maps_key");

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("latlng", `${lat},${lng}`);
  url.searchParams.set("key", key);
  url.searchParams.set("language", "pt-BR");

  const r = await fetchJsonWithTimeout(url, 8000);
  const data = r.data;

  if (data?.status !== "OK" || !data.results?.[0]) throw new Error("reverse_failed");
  return data.results[0].formatted_address;
}

module.exports = { quoteByAddress, reverseGeocode };
