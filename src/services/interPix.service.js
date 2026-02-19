const fs = require('fs');
const https = require('https');
const axios = require('axios');
const ENV = require('../config/env');

// 1. Carrega os certificados de segurança (mTLS) do Inter
let cert, key;
try {
    cert = fs.readFileSync('./certificados/inter.crt');
    key = fs.readFileSync('./certificados/inter.key');
} catch (e) {
    console.error("⚠️ Certificados do Banco Inter não encontrados na pasta './certificados/'");
}

const httpsAgent = cert && key ? new https.Agent({ cert, key }) : null;

/**
 * Função 1: Pegar o Token de Acesso
 */
async function getInterToken(escopo = "cob.write pix.read webhook.write") {
    if (!httpsAgent) return null;
    
    const url = "https://cdpj.partners.bancointer.com.br/oauth/v2/token";
    const data = new URLSearchParams({
        client_id: ENV.INTER_CLIENT_ID,
        client_secret: ENV.INTER_CLIENT_SECRET,
        scope: escopo,
        grant_type: "client_credentials"
    });

    try {
        const response = await axios.post(url, data, {
            httpsAgent,
            headers: { "Content-Type": "application/x-www-form-urlencoded" }
        });
        return response.data.access_token;
    } catch (error) {
        console.error("🔥 Erro no Token do Inter:", error.response?.data || error.message);
        return null;
    }
}

/**
 * Função 2: CRIAR a Cobrança PIX
 */
async function createPixCharge(txid, valor, nomeCliente) {
    const token = await getInterToken("cob.write");
    if (!token) return null;

    const url = `https://cdpj.partners.bancointer.com.br/pix/v2/cob/${txid}`;
    const corpoPix = {
        calendario: { expiracao: 3600 },
        devedor: { nome: nomeCliente },
        valor: { original: valor.toFixed(2), modalidadeAlteracao: 1 },
        chave: ENV.INTER_CHAVE_PIX,
        solicitacaoPagador: "Pagamento Pappi Pizza"
    };

    try {
        const response = await axios.put(url, corpoPix, {
            httpsAgent,
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
                "x-conta-corrente": ENV.INTER_CONTA_CORRENTE
            }
        });
        return response.data;
    } catch (error) {
        console.error("🔥 Erro ao criar PIX:", error.response?.data || error.message);
        return null;
    }
}

/**
 * Função 3: CONSULTAR um PIX específico pelo ID do comprovante
 */
async function getPixByE2eId(e2eId) {
    const token = await getInterToken("pix.read");
    if (!token) return null;

    const url = `https://cdpj.partners.bancointer.com.br/pix/v2/pix/${e2eId}`;

    try {
        const response = await axios.get(url, {
            httpsAgent,
            headers: {
                "Authorization": `Bearer ${token}`,
                "x-conta-corrente": ENV.INTER_CONTA_CORRENTE
            }
        });
        return response.data; 
    } catch (error) {
        console.error("🔥 Erro ao consultar PIX (E2E):", error.response?.data || error.message);
        return null;
    }
}

/**
 * Função 4: Consultar se a cobrança gerada (txid) já foi paga
 */
async function checkCobStatus(txid) {
    const token = await getInterToken("pix.read");
    if (!token) return null;

    const url = `https://cdpj.partners.bancointer.com.br/pix/v2/cob/${txid}`;

    try {
        const response = await axios.get(url, {
            httpsAgent,
            headers: {
                "Authorization": `Bearer ${token}`,
                "x-conta-corrente": ENV.INTER_CONTA_CORRENTE
            }
        });
        return response.data.status; // Retorna "CONCLUIDA" se pago
    } catch (error) {
        console.error("🔥 Erro ao consultar Status da Cobrança:", error.response?.data || error.message);
        return null;
    }
}

/**
 * Função 5: Listar todos os PIX recebidos em um período de tempo
 */
async function listPixPeriod(dataInicioISO, dataFimISO, paginaAtual = 0) {
    const token = await getInterToken("pix.read");
    if (!token) return null;

    const url = "https://cdpj.partners.bancointer.com.br/pix/v2/pix";

    try {
        const response = await axios.get(url, {
            httpsAgent,
            headers: {
                "Authorization": `Bearer ${token}`,
                "x-conta-corrente": ENV.INTER_CONTA_CORRENTE
            },
            params: {
                inicio: dataInicioISO,
                fim: dataFimISO,
                "paginacao.ItensPorPagina": 100,
                "paginacao.PaginaAtual": paginaAtual
            }
        });
        
        return response.data;
    } catch (error) {
        console.error("🔥 Erro ao listar PIX:", error.response?.data || error.message);
        return null;
    }
}

/**
 * Função 6: Configurar o Webhook no Banco Inter
 */
async function configurarWebhookInter() {
    const token = await getInterToken("webhook.write"); 
    if (!token) return console.log("Erro: Sem token para criar webhook");

    const chavePix = ENV.INTER_CHAVE_PIX; 
    const urlBanco = `https://cdpj.partners.bancointer.com.br/pix/v2/webhook/${chavePix}`;
    
    // URL do seu servidor Render onde o banco vai bater
    const meuWebhookUrl = "https://pappi-api.onrender.com/webhook/inter"; 

    try {
        await axios.put(urlBanco, { webhookUrl: meuWebhookUrl }, {
            httpsAgent,
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
                "x-conta-corrente": ENV.INTER_CONTA_CORRENTE
            }
        });
        console.log("✅ Webhook do Banco Inter registado com sucesso!");
    } catch (error) {
        console.error("🔥 Erro ao registar Webhook:", error.response?.data || error.message);
    }
}

module.exports = { 
    createPixCharge, 
    getPixByE2eId, 
    checkCobStatus, 
    listPixPeriod, 
    configurarWebhookInter 
};
