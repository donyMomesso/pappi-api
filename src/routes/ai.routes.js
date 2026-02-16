const express = require("express");
const { chatCompletion } = require("../services/ai.service.js");

const router = express.Router();

router.post("/chat", async (req, res) => {
  try {
    const { message } = req.body || {};

    if (!message) {
      return res.status(400).json({ error: "Envie a 'message' no corpo da requisição." });
    }

    // Define a personalidade e passa um histórico vazio para esse teste isolado
    const systemPrompt = "Você é um atendente da Pappi Pizza. Seja objetivo e cordial.";
    const history = []; 

    // Chama o nosso serviço isolado
    const answer = await chatCompletion(systemPrompt, history, message);

    return res.json({ answer });
  } catch (err) {
    console.error("AI /chat erro:", err);
    return res.status(500).json({ error: "Falha ao gerar resposta." });
  }
});

module.exports = router;
