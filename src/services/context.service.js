function getMode({ customer, now = new Date() }) {
  const day = now.getDay(); // 0 dom, 5 sex, 6 sab
  const isEvent = day === 5 || day === 6;

  const total = Number(customer?.totalOrders || 0);
  const isVip = total >= 3; // ajuste como quiser

  if (isVip) return "VIP";
  if (isEvent) return "EVENT";
  return "BASE";
}

module.exports = { getMode };
