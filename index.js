const { createApp } = require("./src/app");

const PORT = process.env.PORT || 10000;

const app = createApp();

app.listen(PORT, () => {
  console.log("🔥 Pappi API rodando na porta", PORT);
});
