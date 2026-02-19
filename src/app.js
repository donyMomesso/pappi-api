const express = require("express");
const webhookRoutes = require("./routes/webhook.routes");
const publicRoutes = require("./routes/public.routes");
const internalRoutes = require("./routes/internal.routes");
const mapsRoutes = require("./routes/maps.routes");
const adminRulesRoutes = require("./routes/admin.rules.routes"); // 👈 ADICIONE

const app = express();
app.use(express.json({ limit: "10mb" }));

// A ordem aqui é vital para o WhatsApp não travar
app.use("/", webhookRoutes);
app.use("/", publicRoutes);
app.use("/", internalRoutes);
app.use("/", mapsRoutes);

// 👇 REGISTRAR ADMIN
app.use("/admin", adminRulesRoutes);

app.use((req, res) => res.status(404).json({ error: "not_found" }));

app.get("/__ver", (req, res) => res.json({ ok: true, v: "admin-rotas-v1" }));

module.exports = app;
