const express = require("express");
const cors = require("cors");
const { Pinecone } = require("@pinecone-database/pinecone");

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama-3.1-8b-instant";
const HF_TOKEN = process.env.HF_TOKEN;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX = process.env.PINECONE_INDEX || "linoir-products";
const EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2";

// ── Pinecone client (lazy init) ───────────────────────────────────────────────
let pineconeIndex = null;
function getPineconeIndex() {
  if (!pineconeIndex) {
    const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
    pineconeIndex = pinecone.index(PINECONE_INDEX);
  }
  return pineconeIndex;
}

// ── Embed text via Hugging Face ───────────────────────────────────────────────
async function embedText(text) {
  const response = await fetch(
    `https://api-inference.huggingface.co/models/${EMBEDDING_MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: text }),
    }
  );
  if (!response.ok) throw new Error(`HF error: ${await response.text()}`);
  const data = await response.json();
  return data[0];
}

// ── Vector search Pinecone ────────────────────────────────────────────────────
async function searchProducts(query, topK = 4) {
  try {
    const index = getPineconeIndex();
    const vector = await embedText(query);
    const results = await index.query({ vector, topK, includeMetadata: true });

    if (!results.matches || results.matches.length === 0) return "";

    const lines = results.matches.map(m => {
      const d = m.metadata;
      return `- ${d.name} (${d.collection}) | PKR ${Number(d.price).toLocaleString()} | Sizes: ${d.sizes} | Colors: ${d.colors} | ${d.inStock ? "In Stock" : "Out of Stock"}${d.badge ? ` | ${d.badge}` : ""}`;
    });

    return `RELEVANT PRODUCTS FOR THIS QUERY:\n${lines.join("\n")}`;
  } catch (err) {
    console.error("Vector search error:", err.message);
    // Fallback to full catalog if vector search fails
    return buildFullProductContext();
  }
}

// ── Fallback: full product catalog ────────────────────────────────────────────
const products = require("../data/products.json").products;

function buildFullProductContext(filters = {}) {
  let filtered = [...products];
  if (filters.maxPrice) filtered = filtered.filter(p => p.price < filters.maxPrice);
  if (filtered.length === 0) return "No products match the requested criteria.";
  const lines = filtered.map(p =>
    `- ${p.name} (${p.collection}) | PKR ${p.price.toLocaleString()} | Sizes: ${p.sizes.join(", ")} | Colors: ${p.colors.join(", ")} | ${p.inStock ? "In Stock" : "Out of Stock"}${p.badge ? ` | ${p.badge}` : ""}`
  );
  const label = filters.maxPrice ? ` — strictly under PKR ${filters.maxPrice.toLocaleString()}` : "";
  return `LINOIR PRODUCT CATALOG${label} (${filtered.length} products):\n${lines.join("\n")}${filters.maxPrice ? "\n\nIMPORTANT: Only list the products shown above." : ""}`;
}

// ── Orders (in-memory) ────────────────────────────────────────────────────────
const orders = {};

function lookupOrder(orderId) {
  const order = orders[orderId.toUpperCase()];
  if (!order) return `No order found with ID "${orderId}". Please double-check your order number — it starts with LNR- followed by 6 digits.`;
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

// ── System prompt ─────────────────────────────────────────────────────────────
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
5. NEVER list products outside a price filter.
6. If you don't know something, say: "I'll need to check on that — please contact us at support@linoir.pk"

LINOIR POLICIES:
Website: https://linoir.vercel.app
Collections (5 total): Beach, Sports, Girls, Quotes, Cars
Shipping: PKR 200 standard (free above PKR 3,000) | 3–5 business days | All Pakistan
Returns: 7-day policy | Unworn, unwashed, tags attached | support@linoir.pk | Refund in 3–5 days
Promo Codes: LINOIR10 (10% off) | WELCOME20 (20% off new customers)
Payment: Cash on Delivery | Credit/Debit Card | EasyPaisa/JazzCash
Contact: support@linoir.pk | @linoir.pk | Mon–Sat 10am–6pm PKT

${productContext}

Keep responses short, helpful, and conversational.
  `.trim();
}

// ── Groq API ──────────────────────────────────────────────────────────────────
async function callGroq(messages) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 1024, temperature: 0.3 }),
  });
  if (!response.ok) throw new Error(`Groq error: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content.trim();
}

// ── POST /api/chat ────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "Message is required" });
  if (!GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not configured" });

  try {
    // 1 — Order lookup
    const orderMatch = message.match(/LNR[-\s]?\d+/i);
    let orderContext = "";
    if (orderMatch) {
      const orderId = orderMatch[0].replace(/\s/, "-").toUpperCase();
      orderContext = `\n\nORDER LOOKUP RESULT FOR ${orderId}:\n${lookupOrder(orderId)}\n\nThis is a Linoir order query. Use the result above to answer directly.`;
    }

    // 2 — Price filter (use full catalog with filter)
    const priceMatch = message.match(/under\s+PKR?\s*([\d,]+)|below\s+PKR?\s*([\d,]+)|less\s+than\s+PKR?\s*([\d,]+)/i);
    let productContext;

    if (priceMatch) {
      const maxPrice = parseInt((priceMatch[1] || priceMatch[2] || priceMatch[3]).replace(/,/g, ""));
      productContext = buildFullProductContext({ maxPrice });
    } else {
      // 3 — Vector RAG search for everything else
      productContext = await searchProducts(message);
      // Fallback if vector search returns empty
      if (!productContext) productContext = buildFullProductContext();
    }

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
  res.json({ status: "ok", model: GROQ_MODEL, provider: "groq", rag: "pinecone" });
});

module.exports = app;


// ── GET /api/embed ────────────────────────────────────────────────────────────
// Run ONCE to upload products to Pinecone. Hit this URL after deploying.
// After products are uploaded, this endpoint is no longer needed.
app.get("/api/embed", async (req, res) => {
  if (!HF_TOKEN || !PINECONE_API_KEY) {
    return res.status(500).json({ error: "HF_TOKEN or PINECONE_API_KEY not configured" });
  }

  try {
    const index = getPineconeIndex();
    const vectors = [];

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Transfer-Encoding", "chunked");
    res.write("Starting product embedding...\n\n");

    for (const product of products) {
      const text = `
Product: ${product.name}
Collection: ${product.collection}
Price: PKR ${product.price}
Description: ${product.description}
Available Sizes: ${product.sizes.join(", ")}
Available Colors: ${product.colors.join(", ")}
Status: ${product.inStock ? "In Stock" : "Out of Stock"}
${product.badge ? `Badge: ${product.badge}` : ""}
      `.trim();

      try {
        const embedding = await embedText(text);
        vectors.push({
          id: product.id,
          values: embedding,
          metadata: {
            id: product.id,
            name: product.name,
            collection: product.collection,
            price: product.price,
            description: product.description,
            sizes: product.sizes.join(", "),
            colors: product.colors.join(", "),
            inStock: product.inStock,
            badge: product.badge || "",
          },
        });
        res.write(`✅ Embedded: ${product.name}\n`);
      } catch (err) {
        res.write(`❌ Failed: ${product.name} — ${err.message}\n`);
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));
    }

    if (vectors.length > 0) {
      await index.upsert(vectors);
      res.write(`\n✅ Uploaded ${vectors.length} products to Pinecone!\n`);
      res.write("RAG is ready. You can now use the chat.\n");
    } else {
      res.write("\n❌ No products were embedded. Check your HF_TOKEN.\n");
    }

    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});