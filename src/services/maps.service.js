const ENV = require("../config/env");

function calcDeliveryFeeKm(km) {
  // ✅ sua tabela (ajuste se quiser)
  if (km <= 2) return 5;
  if (km <= 3) return 8;
  if (km <= 6) return 12;
  if (km <= 10) return 15;
  return null; // acima de 10km não atende entrega
}

async function quoteByAddress(address) {
  const key = ENV.GOOGLE_MAPS_API_KEY;
  const storeLat = ENV.STORE_LAT;
  const storeLng = ENV.STORE_LNG;

  if (!key) throw new Error("missing_google_maps_key");
  if (!Number.isFinite(storeLat) || !Number.isFinite(storeLng)) throw new Error("missing_store_lat_lng");

  // 1) Geocode
  const geoUrl = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  geoUrl.searchParams.set("address", address);
  geoUrl.searchParams.set("key", key);

  const geoRes = await fetch(geoUrl);
  const geo = await geoRes.json();

  if (geo.status !== "OK" || !geo.results?.[0]) throw new Error("geocode_failed");

  const loc = geo.results[0].geometry.location;
  const formatted = geo.results[0].formatted_address;

  // 2) Distance Matrix
  const dmUrl = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  dmUrl.searchParams.set("origins", `${storeLat},${storeLng}`);
  dmUrl.searchParams.set("destinations", `${loc.lat},${loc.lng}`);
  dmUrl.searchParams.set("mode", "driving");
  dmUrl.searchParams.set("key", key);

  const dmRes = await fetch(dmUrl);
  const dm = await dmRes.json();

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

  const resp = await fetch(url);
  const data = await resp.json();

  if (data.status !== "OK" || !data.results?.[0]) throw new Error("reverse_failed");

  return data.results[0].formatted_address;
}

module.exports = {
  quoteByAddress,
  reverseGeocode,
};
