const ENV = require("../config/env");
const maps = require("./maps.service"); // Importação corrigida (sem "ç")

// Limites de entrega da Pappi Pizza
const MAX_KM = Number(process.env.DELIVERY_MAX_KM || 12);
const SOFT_KM = Number(process.env.DELIVERY_SOFT_KM || 10);

// Heurística Inteligente:
// Só aceita se tiver pelo menos 5 letras (nome da rua) e algum número.
// O Google Maps é esperto, não precisamos exigir que o cliente escreva "Bairro".
function hasEnoughAddress(text) {
  const t = String(text || "").toLowerCase();
  const hasText = t.length > 5; 
  const hasNumber = /\b\d{1,5}\b/.test(t); // Verifica se tem número (ex: 123, 10B)
  return hasText && hasNumber;
}

async function quoteDeliveryIfPossible(addressText) {
  // 1. Segurança: Se não tiver chave do Google, já avisa
  if (!ENV.GOOGLE_MAPS_API_KEY) return { ok: false, reason: "NO_KEY" };

  // 2. Validação: O endereço parece válido?
  if (!hasEnoughAddress(addressText)) return { ok: false, reason: "INCOMPLETE_ADDRESS" };

  try {
    // 3. Consulta o Google Maps
    const q = await maps.quoteByAddress(addressText);
    const km = Number(q?.km);

    // Se o Google não retornou KM, o endereço não foi achado
    if (!Number.isFinite(km)) return { ok: false, reason: "NO_KM" };

    // 4. Regras de Negócio
    const within = q?.is_serviceable === true; // Está dentro da área de entrega?
    const soft = km <= SOFT_KM; // É perto ou longe?

    return {
      ok: true,
      within,
      soft,
      km,
      etaMin: q?.eta_minutes ?? null, // Tempo estimado
      fee: q?.delivery_fee ?? null,   // Taxa de entrega
      formatted: q?.formatted_address || addressText, // Endereço bonitinho do Google
      service_limit_km_hint: MAX_KM,
    };
  } catch (e) {
    console.error("Erro no cálculo de entrega:", e);
    return { ok: false, reason: "QUOTE_FAILED" };
  }
}

module.exports = { quoteDeliveryIfPossible, MAX_KM };
