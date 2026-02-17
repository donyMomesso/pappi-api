const fs = require("fs");
const path = require("path");

let cache = { text: "", mtimeMs: 0 };

function loadRules() {
  const filePath = path.join(__dirname, "rules.md");
  const stats = fs.statSync(filePath);

  if (stats.mtimeMs !== cache.mtimeMs) {
    cache.text = fs.readFileSync(filePath, "utf8");
    cache.mtimeMs = stats.mtimeMs;
    console.log("📜 Regras atualizadas!");
  }

  return cache.text;
}

module.exports = { loadRules };
