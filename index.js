const express = require("express");
const app = express();

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "Pappi Pizza API" });
});

app.post("/orders", (req, res) => {
  res.json({
    status: "pedido_recebido",
    data: req.body
  });
});

app.listen(3000, () => {
  console.log("🔥 Pappi API rodando");
});
