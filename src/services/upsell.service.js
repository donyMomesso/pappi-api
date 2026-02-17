function getSmartUpsell(orderText) {
  if (/gigante|16/i.test(orderText)) {
    return "Quer aproveitar e adicionar uma Coca 2L geladinha por um valor especial? 🥤😉";
  }

  if (/calabresa/i.test(orderText)) {
    return "Essa combina muito com borda recheada 😋 Quer adicionar?";
  }

  return null;
}

module.exports = { getSmartUpsell };
