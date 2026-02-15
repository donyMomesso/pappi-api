const express = require("express");
const ENV = require("../config/env");

const router = express.Router();

function requireApiKey(req, res, next) {
  if (!ENV.ATTENDANT_API_KEY)
    return res.status(500).json({ error: "ATTENDANT_API_KEY not set" });

  const key = req.header("X-API-Key");
  if (key !== ENV.ATTENDANT_API_KEY)
    return res.status(401).json({ error: "Unauthorized" });

  next();
}

router.get("/store", requireApiKey, (req, res) => {
  res.json({
    id: "pappi_pizza",
    name: "Pappi Pizza",
    city: "Campinas",
    state: "SP"
  });
});

module.exports = router;

