// src/services/maps.service.js
const ENV = require("../config/env");

function calcDeliveryFeeKm(km) {
  if (km <= 2) return 5;
  if (km <= 3) return 8;
  if (km <= 6) return 12;
  if (km <= 10) return 15;
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithTimeout(url, opts = {}, ms = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    const json = await resp.json().catch(() => null);
    return { ok: resp.ok, statusCode: resp.status, json };
  } finally {
    clearTimeout(t);
  }
}

async function fetchGoogleJsonWithRetry(url, tries = 2) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchJsonWithTimeout(url, {}, 8000);
      last = r;
      if (r?.json) return r;
    } catch (e) {
      last = { ok: false, statusCode: 0, json: null, error: e };
    }
    await sleep(350);
  }
  return last;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

async function quoteByAddress(address) {
  const key = ENV.GOOGLE_MAPS_API_KEY;

  // ✅ Corrige: ENV vem string → converte para número
  const storeLat = toNumber(ENV.STORE_LAT);
  const storeLng = toNumber(ENV.STORE_LNG);

  if (!key) throw new Error("missing_google_maps_key");
  if (!Number.isFinite(storeLat) || !Number.isFinite(storeLng)) {
    console.error("❌ STORE_LAT/LNG inválidos:", ENV.STORE_LAT, ENV.STORE_LNG);
    throw new Error("missing_store_lat_lng");
  }

  // 1) Geocode
  const geoUrl = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  geoUrl.searchParams.set("address", String(address || ""));
  geoUrl.searchParams.set("key", key);
  geoUrl.searchParams.set("language", "pt-BR");
  geoUrl.searchParams.set("region", "br");

  const geoRes = await fetchGoogleJsonWithRetry(geoUrl, 2);
  const geo = geoRes?.json;

  if (!geo || geo.status !== "OK" || !geo.results?.[0]) {
    console.error("🗺️ GEOCODE FAIL:", geo?.status, geo?.error_message || "", "addr:", address);
    throw new Error("geocode_failed");
  }

  const loc = geo.results[0].geometry.location;
  const formatted = geo.results[0].formatted_address;

  // 2) Distance Matrix
  const dmUrl = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  dmUrl.searchParams.set("origins", `${storeLat},${storeLng}`);
  dmUrl.searchParams.set("destinations", `${loc.lat},${loc.lng}`);
  dmUrl.searchParams.set("mode", "driving");
  dmUrl.searchParams.set("key", key);
  dmUrl.searchParams.set("language", "pt-BR");
  dmUrl.searchParams.set("region", "br");

  const dmRes = await fetchGoogleJsonWithRetry(dmUrl, 2);
  const dm = dmRes?.json;

  const el = dm?.rows?.[0]?.elements?.[0];
  if (!dm || dm.status !== "OK" || !el || el.status !== "OK") {
    console.error("🗺️ DISTANCE MATRIX FAIL:", dm?.status, dm?.error_message || "", "el:", el?.status);
    throw new Error("distance_matrix_failed");
  }

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
  url.searchParams.set("result_type", "street_address|premise|subpremise|route");

  const r = await fetchGoogleJsonWithRetry(url, 2);
  const data = r?.json;

  if (!data || data.status !== "OK" || !data.results?.[0]) {
    console.error("🗺️ REVERSE FAIL:", data?.status, data?.error_message || "", "latlng:", lat, lng);
    throw new Error("reverse_failed");
  }

  return data.results[0].formatted_address;
}

module.exports = {
  quoteByAddress,
  reverseGeocode,
};
