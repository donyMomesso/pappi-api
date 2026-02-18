router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const msgs = extractIncomingMessages(req.body);

    for (const msg of msgs) {
      const from = msg.from;
      const text = (msg.text || "").trim();
      const t = normalizeText(text);

      console.log("📩 MSG:", { from, type: msg.type, text: text.slice(0, 80) });

      // ✅ Se digitar "menu", abre o menu de verdade
      if (t === "menu" || t === "inicio" || t === "começar" || t === "comecar" || t === "oi" || t === "ola") {
        await sendButtons(from, "🍕 Pappi Pizza\nOpa 😄 como posso te ajudar hoje?", [
          { id: "M_PEDIR", title: "🛒 Fazer pedido" },
          { id: "M_CARDAPIO", title: "📖 Cardápio" },
          { id: "M_STATUS", title: "📦 Status" },
        ]);
        continue;
      }

      // ✅ Caso não seja menu, responde e orienta
      await sendText(
        from,
        `👋 Recebi: "${text || "(sem texto)"}"\n\nDigite *menu* pra ver as opções 🍕`
      );
    }
  } catch (err) {
    console.error("🔥 Erro no webhook:", err?.message, err?.payload || "");
  }
});
