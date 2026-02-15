const express = require("express");

const publicRoutes = require("./routes/public.routes");
const internalRoutes = require("./routes/internal.routes");
const mapsRoutes = require("./routes/maps.routes");

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use("/", publicRoutes);
app.use("/", internalRoutes);
app.use("/", mapsRoutes);

app.use((req, res) => res.status(404).json({ error: "not_found" }));

module.exports = app;
