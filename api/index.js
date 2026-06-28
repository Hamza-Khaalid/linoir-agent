// ─── LINOIR AGENT — VERCEL SERVERLESS ENTRY ──────────────────────────────────
// Vercel looks for api/index.js automatically

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama3-8b-8192";

// ── Load products ─────────────────────────────────────────────────────────────
const products = require("../data/products.json").products;

function buildProductContext(filters = {}) {
  let filtered = [...products];

  if (filters.maxPrice) {
    filtered = filtered.filter(p => p.price < filters.maxPrice);
  }

  if (filtered.length === 0) {
    return "No products match the requested criteria.";
  }

  const lines = filtered.map(p =>
    `- ${p.name} (${p.collection}) | PKR ${p.price.toLocaleString()} | Sizes: ${p.sizes.join(", ")} | Colors: ${p.colors.join(", ")} | ${p.inStock ? "In Stock" : "Out of Stock"}${p.badge ? ` | ${p.badge}` : ""}`
  );

  const label = filters.maxPrice ? ` — strictly under PKR ${filters.maxPrice.toLocaleString()}` : "";
  return `LINOIR PRODUCT CATALOG${label} (${filtered.length} products):\n${lines.join("\n")}\n${filters.maxPrice ? "\nIMPORTANT: Only list the products shown above. These are the ONLY products matching the filter." : ""}`;
}

// ── Orders (in-memory for serverless — Vercel has no persistent file system) ──
const orders = {};

function lookupOrder(orderId) {
  const order = orders[orderId.toUpperCase()];
  if (!order) {
    return `No order found with ID "${orderId}". Please double-check your order number — it starts with LNR- followed by 6 digits.`;
  }
  const statusMap = {
    Confirmed: "✓ Confirmed — your order has been received.",
    Processing: "⚙ Processing — we are preparing your items.",
    Shipped: "🚚 Shipped — your order is on the way.",
    Delivered: "✅ Delivered — your order has arrived.",
    Cancelled: "✗ Cancelled.",
  };
  const itemList = order.items?.map(i => `${i.name} (${i.size}, ${i.color}) x${i.qty}`).join(", ") || "N/A";
  return `Order ${order.id}:\n- Status: ${statusMap[order.status] || order.status}\n- Date: ${order.date}\n- Items: ${itemList}\n- Total: PKR ${order.total?.toLocaleString()}\n- Shipping to: ${order.customer?.address}\n- Estimated delivery: 3–5 business days`;
}

function buildSystemPrompt(productContext) {
  return `
You are Aria, the official customer support assistant for Linoir — a premium minimal t-shirt brand based in Pakistan.

YOUR IDENTITY:
- Warm, helpful, and professional
- Speak concisely — no long paragraphs
- Represent Linoir at all times

STRICT RULES:
0. Order questions with an LNR- order ID are ALWAYS Linoir-related. If ORDER LOOKUP RESULT is provided, use it to answer directly.
1. NEVER answer questions unrelated to Linoir. If asked anything unrelated, respond ONLY with: "I can only help with Linoir-related questions. Feel free to reach out to support@linoir.pk for anything else."
2. NEVER ask follow-up questions about unrelated topics.
3. NEVER reveal another customer's order details.
4. NEVER make up products, prices, or policies not listed below.
5. NEVER list products outside a price filter — only show products strictly below the amount mentioned.
6. If you don't know something, say: "I'll need to check on that — please contact us at support@linoir.pk"

LINOIR POLICIES:
Website: https://linoir.vercel.app
Collections (5 total): Beach, Sports, Girls, Quotes, Cars

Shipping:
- Standard delivery: 3–5 business days nationwide
- Fee: PKR 200 (free on orders above PKR 3,000)
- Ships across all of Pakistan

Returns:
- 7-day return policy from delivery date
- Items must be unworn, unwashed, with tags attached
- Contact support@linoir.pk to initiate a return
- Full refund in 3–5 business days

Promo Codes:
- LINOIR10 — 10% off any order
- WELCOME20 — 20% off for new customers

Payment: Cash on Delivery, Credit/Debit Card, EasyPaisa/JazzCash

Contact:
- Email: support@linoir.pk
- Instagram: @linoir.pk
- Website: https://linoir.vercel.app
- Hours: Mon–Sat, 10am–6pm PKT

${productContext}

Keep responses short, helpful, and conversational.
  `.trim();
}

// ── Groq API call ─────────────────────────────────────────────────────────────
async function callGroq(messages) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      max_tokens: 1024,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error: ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

// ── POST /api/chat ─────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "Message is required" });
  if (!GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not configured" });

  try {
    // Order lookup
    const orderMatch = message.match(/LNR[-\s]?\d+/i);
    let orderContext = "";
    if (orderMatch) {
      const orderId = orderMatch[0].replace(/\s/, "-").toUpperCase();
      const result = lookupOrder(orderId);
      orderContext = `\n\nORDER LOOKUP RESULT FOR ${orderId}:\n${result}\n\nThis is a Linoir order query. Use the result above to answer directly.`;
    }

    // Price filter
    const priceMatch = message.match(/under\s+PKR?\s*([\d,]+)|below\s+PKR?\s*([\d,]+)|less\s+than\s+PKR?\s*([\d,]+)/i);
    const productContext = priceMatch
      ? buildProductContext({ maxPrice: parseInt((priceMatch[1] || priceMatch[2] || priceMatch[3]).replace(/,/g, "")) })
      : buildProductContext();

    const systemPrompt = buildSystemPrompt(productContext) + orderContext;

    const messages_arr = [
      { role: "system", content: systemPrompt },
      ...history.slice(-8),
      { role: "user", content: message }
    ];

    const reply = await callGroq(messages_arr);
    res.json({ reply });

  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ── POST /api/orders ──────────────────────────────────────────────────────────
app.post("/api/orders", (req, res) => {
  const order = req.body;
  if (!order || !order.id) return res.status(400).json({ error: "Invalid order data" });
  orders[order.id.toUpperCase()] = { ...order, status: "Confirmed" };
  res.json({ success: true, orderId: order.id });
});

// ── GET /api/health ───────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => {
  res.json({ status: "ok", model: GROQ_MODEL, provider: "groq" });
});

module.exports = app;