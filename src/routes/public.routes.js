const express = require("express");
const ENV = require("../config/env");

const router = express.Router();

router.get("/", (req, res) => {
  res.send("Pappi API online ✅");
});

router.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "API da Pappi Pizza",
    time: new Date().toISOString()
  });
});

router.get("/meta", (req, res) => {
  res.json({
    ok: true,
    app: "API da Pappi Pizza",
    version: "2.0.0",
    env: {
      hasGoogleMaps: Boolean(ENV.GOOGLE_MAPS_API_KEY),
      hasStoreLatLng: Number.isFinite(ENV.STORE_LAT) && Number.isFinite(ENV.STORE_LNG),
    }
  });
});

module.exports = router;

