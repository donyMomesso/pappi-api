const fs = require("fs");
const path = require("path");
const https = require("https");
const axios = require("axios");
const ENV = require("../config/env");

// ===============================
// Certificados (mTLS Banco Inter)
// ===============================
// Opção 1 (recomendado): Render Secret Files -> paths em ENV
//   INTER_CERT_PATH=/etc/secrets/inter.crt
//   INTER_KEY_PATH=/etc/secrets/inter.key
//   INTER_CA_PATH=/etc/secrets/ca.crt
//
// Opção 2: repo local -> /src/certificados/inter.crt etc
// (ajuste a pasta conforme seu projeto; abaixo procura em 2 lugares)

function readIfExists(p) {
  try {
    if (!p) return null;
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

// tenta por ENV (Secret Files) primeiro
const certPathEnv = ENV.INTER_CERT_PATH;
const keyPathEnv = ENV.INTER_KEY_PATH;
const caPathEnv = ENV.INTER_CA_PATH;

// tenta caminhos relativos ao arquivo (mais robusto no Render)
const certPathLocal1 = path.join(__dirname, "..", "..", "certificados", "inter.crt"); // /src/certificados/inter.crt
const keyPathLocal1 = path.join(__dirname, "..", "..", "certificados", "inter.key");
const caPathLocal1 = path.join(__dirname, "..", "..", "certificados", "ca.crt");

// fallback: caso você esteja rodando a partir da raiz e criou /certificados
const certPathLocal2 = path.join(process.cwd(), "certificados", "inter.crt");
const keyPathLocal2 = path.join(process.cwd(), "certificados", "inter.key");
const caPathLocal2 = path.join(process.cwd(), "certificados", "ca.crt");

const cert =
  readIfExists(certPathEnv) ||
  readIfExists(certPathLocal1) ||
  readIfExists(certPathLocal2);

const key =
  readIfExists(keyPathEnv) ||
  readIfExists(keyPathLocal1) ||
  readIfExists(keyPathLocal2);

const ca =
  readIfExists(caPathEnv) ||
  readIfExists(caPathLocal1) ||
  readIfExists(caPathLocal2);

if (!cert || !key) {
  console.error(
    "⚠️ Certificados do Banco Inter não encontrados. " +
      "Configure Secret Files (INTER_CERT_PATH/INTER_KEY_PATH) " +
      "ou coloque em /certificados/inter.crt e /certificados/inter.key"
  );
}

const httpsAgent =
  cert && key
    ? new https.Agent({
        cert,
        key,
        ca: ca || undefined,
      })
    : null;

// ===============================
// Helpers
// ===============================
function mustEnv(name) {
  const v = ENV[name];
  if (!v) console.error(`⚠️ ENV ausente: ${name}`);
  return v;
}

const INTER_OAUTH_URL = "https://cdpj.partners.bancointer.com.br/oauth/v2/token";
const INTER_BASE_PIX = "https://cdpj.partners.bancointer.com.br/pix/v2";

function interHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "x-conta-corrente": ENV.INTER_CONTA_CORRENTE,
  };
}

// ===============================
// 1) Token
// ===============================
async function getInterToken(escopo = "cob.write pix.read webhook.write") {
  if (!httpsAgent) return null;

  // valida env
  mustEnv("INTER_CLIENT_ID");
  mustEnv("INTER_CLIENT_SECRET");

  const data = new URLSearchParams({
    client_id: ENV.INTER_CLIENT_ID,
    client_secret: ENV.INTER_CLIENT_SECRET,
    scope: escopo,
    grant_type: "client_credentials",
  });

  try {
    const response = await axios.post(INTER_OAUTH_URL, data, {
      httpsAgent,
      timeout: 20000,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return response.data.access_token;
  } catch (error) {
    console.error("🔥 Erro no Token do Inter:", error.response?.data || error.message);
    return null;
  }
}

// ===============================
// 2) Criar Cobrança PIX
// ===============================
async function createPixCharge(txid, valor, nomeCliente) {
  const token = await getInterToken("cob.write");
  if (!token) return null;

  mustEnv("INTER_CHAVE_PIX");
  mustEnv("INTER_CONTA_CORRENTE");

  const url = `${INTER_BASE_PIX}/cob/${txid}`;

  const corpoPix = {
    calendario: { expiracao: 3600 },
    devedor: { nome: String(nomeCliente || "Cliente Pappi").slice(0, 25) }, // Inter costuma validar tamanho
    valor: { original: Number(valor).toFixed(2), modalidadeAlteracao: 1 },
    chave: ENV.INTER_CHAVE_PIX,
    solicitacaoPagador: "Pagamento Pappi Pizza",
  };

  try {
    const response = await axios.put(url, corpoPix, {
      httpsAgent,
      timeout: 20000,
      headers: interHeaders(token),
    });
    return response.data;
  } catch (error) {
    console.error("🔥 Erro ao criar PIX:", error.response?.data || error.message);
    return null;
  }
}

// ===============================
// 3) Consultar PIX por E2E
// ===============================
async function getPixByE2eId(e2eId) {
  const token = await getInterToken("pix.read");
  if (!token) return null;

  mustEnv("INTER_CONTA_CORRENTE");

  const url = `${INTER_BASE_PIX}/pix/${e2eId}`;

  try {
    const response = await axios.get(url, {
      httpsAgent,
      timeout: 20000,
      headers: interHeaders(token),
    });
    return response.data;
  } catch (error) {
    console.error("🔥 Erro ao consultar PIX (E2E):", error.response?.data || error.message);
    return null;
  }
}

// ===============================
// 4) Status da cobrança (txid)
// ===============================
async function checkCobStatus(txid) {
  const token = await getInterToken("pix.read");
  if (!token) return null;

  mustEnv("INTER_CONTA_CORRENTE");

  const url = `${INTER_BASE_PIX}/cob/${txid}`;

  try {
    const response = await axios.get(url, {
      httpsAgent,
      timeout: 20000,
      headers: interHeaders(token),
    });
    return response.data.status; // "CONCLUIDA" quando paga
  } catch (error) {
    console.error("🔥 Erro ao consultar Status da Cobrança:", error.response?.data || error.message);
    return null;
  }
}

// ===============================
// 5) Listar PIX por período
// ===============================
async function listPixPeriod(dataInicioISO, dataFimISO, paginaAtual = 0) {
  const token = await getInterToken("pix.read");
  if (!token) return null;

  mustEnv("INTER_CONTA_CORRENTE");

  const url = `${INTER_BASE_PIX}/pix`;

  try {
    const response = await axios.get(url, {
      httpsAgent,
      timeout: 20000,
      headers: interHeaders(token),
      params: {
        inicio: dataInicioISO,
        fim: dataFimISO,
        "paginacao.ItensPorPagina": 100,
        "paginacao.PaginaAtual": paginaAtual,
      },
    });

    return response.data;
  } catch (error) {
    console.error("🔥 Erro ao listar PIX:", error.response?.data || error.message);
    return null;
  }
}

// ===============================
// 6) Configurar Webhook Inter
// ===============================
async function configurarWebhookInter() {
  const token = await getInterToken("webhook.write");
  if (!token) return console.log("Erro: Sem token para criar webhook");

  mustEnv("INTER_CHAVE_PIX");
  mustEnv("INTER_CONTA_CORRENTE");

  const chavePix = ENV.INTER_CHAVE_PIX;
  const urlBanco = `${INTER_BASE_PIX}/webhook/${chavePix}`;

  const meuWebhookUrl = "https://pappi-api.onrender.com/webhook/inter";

  try {
    await axios.put(
      urlBanco,
      { webhookUrl: meuWebhookUrl },
      {
        httpsAgent,
        timeout: 20000,
        headers: interHeaders(token),
      }
    );
    console.log("✅ Webhook do Banco Inter registrado com sucesso!");
  } catch (error) {
    console.error("🔥 Erro ao registrar Webhook:", error.response?.data || error.message);
  }
}

module.exports = {
  createPixCharge,
  getPixByE2eId,
  checkCobStatus,
  listPixPeriod,
  checkCobStatus,
  configurarWebhookInter,
  // se quiser usar em outro lugar:
  getInterToken,
};
