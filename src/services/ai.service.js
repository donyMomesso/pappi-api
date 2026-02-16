const { GoogleGenerativeAI } = require("@google/generative-ai");

// Inicializa a IA do Google
const apiKey = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

async function chatCompletion(messagesArray) {
    try {
        if (!apiKey) throw new Error("Chave GEMINI_API_KEY ausente no Render.");

        // Traduz o formato de mensagens para um roteiro que o Gemini entende perfeitamente
        let fullPrompt = "";
        messagesArray.forEach(msg => {
            if (msg.role === "system") fullPrompt += `Instruções: ${msg.content}\n\n---\n\n`;
            if (msg.role === "user") fullPrompt += `Cliente: ${msg.content}\n`;
            if (msg.role === "assistant") fullPrompt += `Atendente: ${msg.content}\n`;
        });
        
        fullPrompt += "Atendente:";

        const result = await model.generateContent(fullPrompt);
        return result.response.text();
    } catch (error) {
        console.error("🔥 Erro no Serviço de IA (Gemini):", error);
        throw error;
    }
}

module.exports = { chatCompletion };
