const fs = require("fs");
const path = require("path");

function loadFile(name) {
  const filePath = path.join(__dirname, name);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function loadRules(mode) {
  const base = loadFile("rules.md");

  if (mode === "VIP") {
    return base + "\n\n" + loadFile("vip.md");
  }

  if (mode === "EVENT") {
    return base + "\n\n" + loadFile("event.md");
  }

  return base;
}

module.exports = { loadRules };
