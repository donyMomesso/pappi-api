const { GoogleGenerativeAI } = require("@google/generative-ai");

// Inicializa a IA do Google
const apiKey = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

async function chatCompletion(systemPrompt, history, userMessage) {
    try {
        if (!apiKey) throw new Error("Chave GEMINI_API_KEY ausente.");

        // Monta o script juntando a personalidade, o histórico e a mensagem atual
        const fullPrompt = `${systemPrompt}\n\n--- HISTÓRICO ---\n${history.join("\n")}\n\nCliente: ${userMessage}\nAtendente Pappi Pizza:`;

        const result = await model.generateContent(fullPrompt);
        return result.response.text();
    } catch (error) {
        console.error("🔥 Erro no Serviço de IA:", error);
        throw error; // Repassa o erro para quem chamou a função tratar
    }
}

module.exports = { chatCompletion };
