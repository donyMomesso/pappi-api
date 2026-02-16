const express = require("express");

const publicRoutes = require("./routes/public.routes");
const internalRoutes = require("./routes/internal.routes");
const mapsRoutes = require("./routes/maps.routes");
const webhookRoutes = require("./routes/webhook.routes");
const aiRoutes = require("./routes/ai.routes"); // <-- Importando a nova rota de IA

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use("/", webhookRoutes);
app.use("/", publicRoutes);
app.use("/", internalRoutes);
app.use("/", mapsRoutes);
app.use("/api/ai", aiRoutes); // <-- Ligando a rota (ficará /api/ai/chat)

app.use((req, res) => res.status(404).json({ error: "not_found" }));

module.exports = app;
