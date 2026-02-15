const express = require("express");

const publicRoutes = require("./routes/public.routes");
const protectedRoutes = require("./routes/protected.routes");

const app = express();
app.use(express.json({ limit: "10mb" }));

// Rotas públicas
app.use("/", publicRoutes);

// Rotas protegidas
app.use("/", protectedRoutes);

// 404 padrão
app.use((req, res) => res.status(404).json({ error: "not_found" }));

module.exports = app;
