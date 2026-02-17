const { GoogleGenerativeAI } = require("@google/generative-ai");

// ===============================
// CONFIG
// ===============================
const apiKey = process.env.GEMINI_API_KEY || "";

if (!apiKey) {
  console.warn("⚠️ GEMINI_API_KEY não configurada.");
}

const genAI = new GoogleGenerativeAI(apiKey);

// Modelos em ordem de prioridade (rotaciona se estourar quota)
const MODELS = [
  process.env.GEMINI_MODEL || "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite"
];

// ===============================
// HELPERS
// ===============================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaError(err) {
  return err?.status === 429 || String(err?.message || "").includes("429");
}

function parseRetryDelaySeconds(err) {
  try {
    const details = err?.errorDetails || [];
    const retryInfo = details.find(d => d?.retryDelay);
    if (!retryInfo?.retryDelay) return 0;
    const match = String(retryInfo.retryDelay).match(/(\d+)\s*s/i);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

// ===============================
// CHAT COMPLETION (VERSÃO ROBUSTA)
// ===============================
async function chatCompletion(messagesArray) {
  if (!apiKey) {
    throw new Error("Chave GEMINI_API_KEY ausente no Render.");
  }

  // Monta prompt no formato que Gemini entende
  let fullPrompt = "";

  messagesArray.forEach(msg => {
    if (msg.role === "system") {
      fullPrompt += `INSTRUÇÕES:\n${msg.content}\n\n---\n\n`;
    }
    if (msg.role === "user") {
      fullPrompt += `Cliente: ${msg.content}\n`;
    }
    if (msg.role === "assistant") {
      fullPrompt += `Atendente: ${msg.content}\n`;
    }
  });

  fullPrompt += "Atendente:";

  let lastError = null;

  // Tenta cada modelo da lista
  for (const modelName of MODELS) {
    try {
      console.log("🤖 Tentando modelo:", modelName);

      const model = genAI.getGenerativeModel({
        model: modelName.replace(/^models\//, "")
      });

      const result = await model.generateContent(fullPrompt);
      return result.response.text();

    } catch (error) {
      lastError = error;

      // Se for quota, tenta esperar e ir pro próximo modelo
      if (isQuotaError(error)) {
        console.warn("⚠️ Quota atingida no modelo:", modelName);

        const retrySeconds = parseRetryDelaySeconds(error);
        if (retrySeconds > 0 && retrySeconds <= 15) {
          await sleep((retrySeconds + 1) * 1000);
        }

        continue; // tenta próximo modelo
      }

      // Outro erro qualquer → tenta próximo modelo
      console.warn("⚠️ Erro no modelo:", modelName, error.message);
      continue;
    }
  }

  // Se nenhum modelo funcionou
  console.error("🔥 Todos modelos falharam:", lastError?.message);

  // NÃO quebra o sistema
  return null;
}

module.exports = { chatCompletion };
