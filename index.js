const express = require("express");
const swaggerUi = require("swagger-ui-express");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== CONFIG =====
const API_KEY = process.env.ATTENDANT_API_KEY;
const DEFAULT_WPP = "+55 19 98227-5105";

// In-memory store (temporário)
const ORDERS = new Map();

function nowIso() {
  return new Date().toISOString();
}

// ===== AUTH =====
function requireApiKey(req, res, next) {
  const key = req.header("X-API-Key");

  if (!API_KEY) {
    return res.status(500).json({
      error: "ServerMisconfigured",
      message: "ATTENDANT_API_KEY não configurada no Render (Environment)."
    });
  }

  if (!key || key !== API_KEY) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "API Key inválida ou ausente"
    });
  }

  next();
}

// ===== VALIDAR PEDIDO =====
function validateOrderBody(body) {
  const errors = [];

  if (!body || typeof body !== "object") errors.push("Body inválido.");
  if (!body.channel || !["site", "whatsapp"].includes(body.channel)) {
    errors.push("channel deve ser 'site' ou 'whatsapp'.");
  }

  const c = body.customer;
  if (!c || typeof c !== "object") errors.push("customer é obrigatório.");
  else {
    if (!c.name || typeof c.name !== "string") errors.push("customer.name é obrigatório.");
    if (!c.phone || typeof c.phone !== "string") errors.push("customer.phone é obrigatório.");
  }

  if (!Array.isArray(body.items) || body.items.length < 1) {
    errors.push("items deve ter pelo menos 1 item.");
  } else {
    body.items.forEach((it, i) => {
      if (!it.itemId) errors.push(`items[${i}].itemId é obrigatório.`);
      if (!it.name) errors.push(`items[${i}].name é obrigatório.`);
      if (!Number.isInteger(it.quantity) || it.quantity < 1) errors.push(`items[${i}].quantity deve ser inteiro >= 1.`);
      if (typeof it.unitPrice !== "number" || Number.isNaN(it.unitPrice)) errors.push(`items[${i}].unitPrice deve ser número.`);
    });
  }

  return errors;
}

// ===== OPENAPI (para Stoplight + Swagger) =====
const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Pappi Pizza Actions API (PRO)",
    version: "1.0.0",
    description:
      "API interna da Pappi Pizza para atendentes via GPT Actions. Endpoints públicos: /health, /meta, /openapi.json, /docs. Protegidos: /orders, /checkout/whatsapp, /orders/:orderId."
  },
  servers: [{ url: "https://pappi-api.onrender.com" }],
  components: {
    securitySchemes: {
      AttendantApiKey: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key"
      }
    },
    schemas: {
      OrderCreate: {
        type: "object",
        required: ["channel", "customer", "items"],
        properties: {
          channel: { type: "string", enum: ["site", "whatsapp"] },
          customer: {
            type: "object",
            required: ["name", "phone"],
            properties: {
              name: { type: "string" },
              phone: { type: "string" },
              address: {
                type: "object",
                properties: {
                  street: { type: "string" },
                  neighborhood: { type: "string" },
                  city: { type: "string" },
                  state: { type: "string" },
                  zip: { type: "string" },
                  reference: { type: "string" }
                }
              }
            }
          },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["itemId", "name", "quantity", "unitPrice"],
              properties: {
                itemId: { type: "string" },
                name: { type: "string" },
                quantity: { type: "integer", minimum: 1 },
                unitPrice: { type: "number" },
                notes: { type: "string" }
              }
            }
          },
          deliveryFee: { type: "number" },
          discount: { type: "number" }
        }
      },
      Order: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          channel: { type: "string" },
          customer: { type: "object" },
          items: { type: "array", items: { type: "object" } },
          totals: { type: "object" },
          createdAt: { type: "string" },
          updatedAt: { type: "string" }
        }
      },
      CheckoutRequest: {
        type: "object",
        required: ["orderId"],
        properties: {
          orderId: { type: "string" },
          preferredWhatsApp: { type: "string" }
        }
      },
      CheckoutResponse: {
        type: "object",
        properties: {
          channel: { type: "string" },
          whatsappNumber: { type: "string" },
          whatsappUrl: { type: "string" },
          messageText: { type: "string" }
        }
      }
    }
  },
  security: [{ AttendantApiKey: [] }],
  paths: {
    "/health": {
      get: {
        operationId: "health",
        security: [],
        responses: { "200": { description: "OK" } }
      }
    },
    "/meta": {
      get: {
        operationId: "getMeta",
        security: [],
        responses: { "200": { description: "OK" } }
      }
    },
    "/openapi.json": {
      get: {
        operationId: "getOpenApi",
        security: [],
        responses: { "200": { description: "OpenAPI JSON" } }
      }
    },
    "/docs": {
      get: {
        operationId: "getDocs",
        security: [],
        responses: { "200": { description: "Swagger UI" } }
      }
    },
    "/debug-auth": {
      get: {
        operationId: "debugAuth",
        responses: {
          "200": { description: "Mostra se a key do header chegou (não expõe a key)" }
        }
      }
    },
    "/orders": {
      post: {
        operationId: "createOrder",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/OrderCreate" } }
          }
        },
        responses: {
          "201": {
            description: "Created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } }
          },
          "400": { description: "BadRequest" },
          "401": { description: "Unauthorized" }
        }
      },
      get: {
        operationId: "listOrders",
        responses: {
          "200": { description: "OK" },
          "401": { description: "Unauthorized" }
        }
      }
    },
    "/orders/{orderId}": {
      get: {
        operationId: "getOrderById",
        parameters: [
          {
            name: "orderId",
            in: "path",
            required: true,
            schema: { type: "string" }
          }
        ],
        responses: {
          "200": { description: "OK" },
          "404": { description: "NotFound" },
          "401": { description: "Unauthorized" }
        }
      }
    },
    "/checkout/whatsapp": {
      post: {
        operationId: "checkoutWhatsApp",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/CheckoutRequest" } }
          }
        },
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CheckoutResponse" } }
            }
          },
          "400": { description: "BadRequest" },
          "404": { description: "NotFound" },
          "401": { description: "Unauthorized" }
        }
      }
    }
  }
};

// ===== OPENAPI ENDPOINTS =====
app.get("/openapi.json", (req, res) => res.json(OPENAPI));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(OPENAPI));

// ===== PUBLIC =====
app.get("/health", (req, res) => {
  res.json({ ok: true, app: "Pappi Pizza API", time: nowIso() });
});

app.get("/meta", (req, res) => {
  res.json({
    storeName: "Pappi Pizza",
    menuUrl: "https://app.cardapioweb.com/pappi_pizza?s=dony",
    whatsappNumbers: ["+55 19 98319-3999", "+55 19 98227-5105"]
  });
});

// ===== DEBUG (TEMPORÁRIO) =====
app.get("/debug-auth", (req, res) => {
  const key = req.header("X-API-Key") || "";
  res.json({
    hasEnvKey: Boolean(process.env.ATTENDANT_API_KEY),
    envKeyLength: (process.env.ATTENDANT_API_KEY || "").length,
    hasHeaderKey: Boolean(key),
    headerKeyLength: key.length
  });
});

// ===== PROTECTED (atendentes) =====
app.post("/orders", requireApiKey, (req, res) => {
  const errors = validateOrderBody(req.body);
  if (errors.length) return res.status(400).json({ error: "BadRequest", messages: errors });

  const orderId = "ord_" + Math.random().toString(36).slice(2, 10);

  const subtotal = req.body.items.reduce((acc, it) => acc + it.quantity * it.unitPrice, 0);
  const deliveryFee = typeof req.body.deliveryFee === "number" ? req.body.deliveryFee : 0;
  const discount = typeof req.body.discount === "number" ? req.body.discount : 0;
  const total = Math.max(0, subtotal + deliveryFee - discount);

  const order = {
    id: orderId,
    status: "received",
    channel: req.body.channel,
    customer: req.body.customer,
    items: req.body.items,
    totals: { subtotal, deliveryFee, discount, total },
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  ORDERS.set(orderId, order);
  return res.status(201).json(order);
});

app.get("/orders", requireApiKey, (req, res) => {
  res.json(Array.from(ORDERS.values()));
});

app.get("/orders/:orderId", requireApiKey, (req, res) => {
  const order = ORDERS.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: "NotFound", message: "Pedido não encontrado." });
  res.json(order);
});

app.post("/checkout/whatsapp", requireApiKey, (req, res) => {
  const { orderId, preferredWhatsApp } = req.body || {};
  if (!orderId || typeof orderId !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "orderId é obrigatório." });
  }

  const order = ORDERS.get(orderId);
  if (!order) return res.status(404).json({ error: "NotFound", message: "Pedido não encontrado." });

  const number = (preferredWhatsApp || DEFAULT_WPP).replace(/\D/g, "");

  const itemsText = order.items
    .map(it => `• ${it.quantity}x ${it.name} (R$ ${Number(it.unitPrice).toFixed(2)})`)
    .join("\n");

  const messageText =
    `Olá! Quero finalizar meu pedido na *Pappi Pizza* 🍕\n` +
    `Pedido: ${orderId}\n\n` +
    `Itens:\n${itemsText}\n\n` +
    `Total: *R$ ${order.totals.total.toFixed(2)}*\n` +
    `Cardápio: https://app.cardapioweb.com/pappi_pizza?s=dony`;

  const whatsappUrl = `https://wa.me/${number}?text=${encodeURIComponent(messageText)}`;

  res.json({
    channel: "whatsapp",
    whatsappNumber: preferredWhatsApp || DEFAULT_WPP,
    whatsappUrl,
    messageText
  });
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🔥 Pappi API rodando na porta", PORT));
