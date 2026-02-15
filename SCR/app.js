const express = require("express");

const publicRoutes = require("./routes/public.routes");
const mapsRoutes = require("./routes/maps.routes");
const internalRoutes = require("./routes/internal.routes");

function createApp() {
  const app = express();

  app.use(express.json({ limit: "10mb" }));

  app.use("/", publicRoutes);
  app.use("/", mapsRoutes);
  app.use("/", internalRoutes);

  return app;
}

module.exports = { createApp };

