const express = require("express");

const publicRoutes = require("./routes/public.routes");
const internalRoutes = require("./routes/internal.routes");
const mapsRoutes = require("./routes/maps.routes");

const app = express();

app.use(express.json({ limit: "10mb" }));

// Rotas públicas
app.use("/", publicRoutes);

// Rotas internas (protegidas por API KEY dentro do arquivo)
app.use("/", internalRoutes);

// Rotas de Maps
app.use("/", mapsRoutes);

// 404 padrão
app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

module.exports = app;
