// NÃO usar dotenv no Render
// O Render já injeta process.env automaticamente

module.exports = {
  PORT: process.env.PORT,
  ATTENDANT_API_KEY: process.env.ATTENDANT_API_KEY,
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  STORE_LAT: process.env.STORE_LAT,
  STORE_LNG: process.env.STORE_LNG,
  HUMAN_WA_NUMBER: process.env.HUMAN_WA_NUMBER
};
