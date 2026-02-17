function getMode({ customer, now = new Date() }) {
  if (!customer) return "BASE";

  const last = customer.lastInteraction
    ? new Date(customer.lastInteraction)
    : null;

  const hoursSinceLast = last
    ? (now - last) / (1000 * 60 * 60)
    : 999;

  // Cliente que voltou em menos de 24h → VIP
  if (hoursSinceLast <= 24) return "VIP";

  // Sexta ou sábado → EVENT
  const day = now.getDay(); // 5 = sexta, 6 = sábado
  if (day === 5 || day === 6) return "EVENT";

  return "BASE";
}

module.exports = { getMode };
