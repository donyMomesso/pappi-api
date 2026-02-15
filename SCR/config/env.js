// No Render, ENV já vem pronta. Dotenv só é útil localmente.
// Se quiser manter local, use assim:
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}
const ENV = {
  PORT: process.env.PORT || 10000,
  ATTENDANT_API_KEY: process.env.ATTENDANT_API_KEY || "",
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || "",
  STORE_LAT: Number(process.env.STORE_LAT),
  STORE_LNG: Number(process.env.STORE_LNG),
};

module.exports = ENV;

