const app = require("./src/app");

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🔥 Pappi API rodando na porta ${PORT}`);
});
