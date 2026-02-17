function getContextMode(customer, now = new Date()) {
  const day = now.getDay(); // 0 = domingo

  const isWeekend = day === 5 || day === 6; // sexta ou sábado

  if (customer?.totalOrders >= 3) {
    return "VIP";
  }

  if (isWeekend) {
    return "EVENT";
  }

  return "BASE";
}

module.exports = { getContextMode };
