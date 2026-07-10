const express = require("express");
const cors = require("cors");
const { Pinecone } = require("@pinecone-database/pinecone");
const { MongoClient } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama-3.1-8b-instant";
const JINA_API_KEY = process.env.JINA_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX = process.env.PINECONE_INDEX || "linoir-products";
const MONGODB_URI = process.env.MONGODB_URI;

// ── MongoDB client ────────────────────────────────────────────────────────────
let cachedClient = null;

async function getDB() {
  if (cachedClient) {
    try {
      // ping to verify connection is still alive
      await cachedClient.db("admin").command({ ping: 1 });
      return cachedClient.db("linoir");
    } catch {
      cachedClient = null;
    }
  }
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });
  await client.connect();
  cachedClient = client;
  return client.db("linoir");
}

// ── Pinecone client ───────────────────────────────────────────────────────────
let pineconeIndex = null;
function getPineconeIndex() {
  if (!pineconeIndex) {
    const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
    pineconeIndex = pinecone.index(PINECONE_INDEX);
  }
  return pineconeIndex;
}

// ── Jina embeddings ───────────────────────────────────────────────────────────
async function embedText(text) {
  const response = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${JINA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "jina-embeddings-v3", input: [text], task: "retrieval.passage" }),
  });
  if (!response.ok) throw new Error(`Jina error: ${await response.text()}`);
  return (await response.json()).data[0].embedding;
}

async function embedQuery(text) {
  const response = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${JINA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "jina-embeddings-v3", input: [text], task: "retrieval.query" }),
  });
  if (!response.ok) throw new Error(`Jina error: ${await response.text()}`);
  return (await response.json()).data[0].embedding;
}

// ── Vector search ─────────────────────────────────────────────────────────────
async function searchProducts(query, topK = 4) {
  try {
    const index = getPineconeIndex();
    const vector = await embedQuery(query);
    const results = await index.query({ vector, topK, includeMetadata: true });
    if (!results.matches || results.matches.length === 0) return "";
    const lines = results.matches.map(m => {
      const d = m.metadata;
      return `- ${d.name} (${d.collection}) | PKR ${Number(d.price).toLocaleString()} | Sizes: ${d.sizes} | Colors: ${d.colors} | ${d.inStock ? "In Stock" : "Out of Stock"}${d.badge ? ` | ${d.badge}` : ""}`;
    });
    return `RELEVANT PRODUCTS FOR THIS QUERY:\n${lines.join("\n")}`;
  } catch (err) {
    console.error("Vector search error:", err.message);
    return buildFullProductContext();
  }
}

// ── Product catalog ───────────────────────────────────────────────────────────
const products = require("../data/products.json").products;

function buildFullProductContext(filters = {}) {
  let filtered = [...products];
  if (filters.maxPrice) filtered = filtered.filter(p => p.price < filters.maxPrice);
  if (filtered.length === 0) return "No products match the requested criteria.";
  const lines = filtered.map(p =>
    `- ${p.name} (${p.collection}) | PKR ${p.price.toLocaleString()} | Sizes: ${p.sizes.join(", ")} | Colors: ${p.colors.join(", ")} | ${p.inStock ? "In Stock" : "Out of Stock"}${p.badge ? ` | ${p.badge}` : ""}`
  );
  const label = filters.maxPrice ? ` strictly under PKR ${filters.maxPrice.toLocaleString()}` : "";
  return `LINOIR PRODUCT CATALOG${label} (${filtered.length} products):\n${lines.join("\n")}${filters.maxPrice ? "\n\nIMPORTANT: Only list the products shown above." : ""}`;
}

// ── Orders ────────────────────────────────────────────────────────────────────
async function saveOrder(order) {
  const db = await getDB();
  const collection = db.collection("orders");
  await collection.updateOne(
    { id: order.id },
    { $set: { ...order, status: "Confirmed", savedAt: new Date() } },
    { upsert: true }
  );
}

async function lookupOrder(orderId) {
  try {
    const db = await getDB();
    const collection = db.collection("orders");
    const order = await collection.findOne({ id: orderId.toUpperCase() });
    if (!order) return null;

    const statusMap = {
      Confirmed: "Confirmed - your order has been received.",
      Processing: "Processing - we are preparing your items.",
      Shipped: "Shipped - your order is on the way.",
      Delivered: "Delivered - your order has arrived.",
      Cancelled: "Cancelled.",
    };

    const itemList = order.items?.map(i => `${i.name} (${i.size}, ${i.color}) x${i.qty}`).join(", ") || "N/A";

    return `Order ${order.id}:
- Status: ${statusMap[order.status] || order.status}
- Date: ${order.date}
- Items: ${itemList}
- Total: PKR ${order.total?.toLocaleString()}
- Shipping to: ${order.customer?.address}
- Estimated delivery: 3-5 business days`;
  } catch (err) {
    console.error("Order lookup error:", err.message);
    return null;
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(productContext) {
  return `
You are Aria, the official customer support assistant for Linoir - a premium minimal t-shirt brand based in Pakistan.

YOUR IDENTITY:
- Warm, helpful, and professional
- Speak concisely - no long paragraphs
- Represent Linoir at all times

STRICT RULES:
0. Order questions with an LNR- order ID are ALWAYS Linoir-related. If ORDER LOOKUP RESULT is provided, use it to answer directly.
1. NEVER answer questions unrelated to Linoir. If asked anything unrelated, respond ONLY with: "I can only help with Linoir-related questions. Feel free to reach out to support@linoir.pk for anything else."
2. NEVER ask follow-up questions about unrelated topics.
3. NEVER reveal another customer's order details.
4. NEVER make up products, prices, or policies not listed below.
5. NEVER list products outside a price filter.
6. If you don't know something, say: "I'll need to check on that - please contact us at support@linoir.pk"

LINOIR POLICIES:
Website: https://linoir.vercel.app
Collections (5 total): Beach, Sports, Girls, Quotes, Cars
Shipping: PKR 200 standard (free above PKR 3,000) | 3-5 business days | All Pakistan
Returns: 7-day policy | Unworn, unwashed, tags attached | support@linoir.pk | Refund in 3-5 days
Promo Codes: LINOIR10 (10% off) | WELCOME20 (20% off new customers)
Payment: Cash on Delivery | Credit/Debit Card | EasyPaisa/JazzCash
Contact: support@linoir.pk | @linoir.pk | Mon-Sat 10am-6pm PKT

${productContext}

Keep responses short, helpful, and conversational.
  `.trim();
}

// ── Groq ──────────────────────────────────────────────────────────────────────
async function callGroq(messages) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 1024, temperature: 0.3 }),
  });
  if (!response.ok) throw new Error(`Groq error: ${await response.text()}`);
  return (await response.json()).choices[0].message.content.trim();
}

// ── POST /api/chat ────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "Message is required" });
  if (!GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not configured" });

  try {
    const orderMatch = message.match(/LNR[-\s]?\d+/i);
    let orderContext = "";

    if (orderMatch) {
      const orderId = orderMatch[0].replace(/\s/, "-").toUpperCase();
      const orderResult = await lookupOrder(orderId);
      if (orderResult) {
        orderContext = `\n\nORDER LOOKUP RESULT FOR ${orderId}:\n${orderResult}\n\nThis is a Linoir order query. Use the result above to answer directly.`;
      } else {
        orderContext = `\n\nORDER LOOKUP: The customer provided order ID ${orderId}. This order does NOT exist in our system. You must respond with EXACTLY this message and nothing else: "I wasn't able to find an order with that ID. Please double-check your order number - it should look like LNR- followed by 6 digits. If you believe this is correct, please contact us at support@linoir.pk"`;
      }
    }

    const priceMatch = message.match(/under\s+PKR?\s*([\d,]+)|below\s+PKR?\s*([\d,]+)|less\s+than\s+PKR?\s*([\d,]+)/i);
    let productContext;

    if (priceMatch) {
      const maxPrice = parseInt((priceMatch[1] || priceMatch[2] || priceMatch[3]).replace(/,/g, ""));
      productContext = buildFullProductContext({ maxPrice });
    } else if (JINA_API_KEY && PINECONE_API_KEY) {
      productContext = await searchProducts(message);
      if (!productContext) productContext = buildFullProductContext();
    } else {
      productContext = buildFullProductContext();
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
// app.post("/api/orders", async (req, res) => {
//   const order = req.body;
//   if (!order || !order.id) return res.status(400).json({ error: "Invalid order data" });
//   try {
//     await saveOrder(order);
//     console.log("Order saved successfully:", order.id);
//     res.json({ success: true, orderId: order.id });
//   } catch (err) {
//     console.error("Save order error:", err.message);
//     res.status(500).json({ error: "Could not save order" });
//   }
// });

app.post("/api/orders", async (req, res) => {
  const order = req.body;
  if (!order || !order.id) return res.status(400).json({ error: "Invalid order data" });
  
  try {
    console.log("MONGODB_URI exists:", !!MONGODB_URI);
    console.log("Connecting to MongoDB...");
    
    const client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    
    await client.connect();
    console.log("Connected!");
    
    const db = client.db("linoir");
    const collection = db.collection("orders");
    
    await collection.updateOne(
      { id: order.id },
      { $set: { ...order, status: "Confirmed", savedAt: new Date() } },
      { upsert: true }
    );
    
    await client.close();
    console.log("Order saved:", order.id);
    res.json({ success: true, orderId: order.id });
    
  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/health ───────────────────────────────────────────────────────────
app.get("/api/health", async (_, res) => {
  let mongoStatus = "disconnected";
  try {
    await getDB();
    mongoStatus = "connected";
  } catch (err) {
    console.error("Health check DB error:", err.message);
  }
  res.json({ status: "ok", model: GROQ_MODEL, provider: "groq", embeddings: "jina", rag: "pinecone", database: mongoStatus });
});

// ── GET /api/embed ────────────────────────────────────────────────────────────
app.get("/api/embed", async (req, res) => {
  if (!JINA_API_KEY || !PINECONE_API_KEY) {
    return res.status(500).json({ error: "JINA_API_KEY or PINECONE_API_KEY not configured" });
  }
  try {
    const index = getPineconeIndex();
    const vectors = [];
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Transfer-Encoding", "chunked");
    res.write("Starting product embedding with Jina AI...\n\n");

    for (const product of products) {
      const text = `Product: ${product.name}\nCollection: ${product.collection}\nPrice: PKR ${product.price}\nDescription: ${product.description}\nSizes: ${product.sizes.join(", ")}\nColors: ${product.colors.join(", ")}\nStatus: ${product.inStock ? "In Stock" : "Out of Stock"}${product.badge ? `\nBadge: ${product.badge}` : ""}`;
      try {
        const embedding = await embedText(text);
        vectors.push({
          id: product.id,
          values: embedding,
          metadata: { id: product.id, name: product.name, collection: product.collection, price: product.price, description: product.description, sizes: product.sizes.join(", "), colors: product.colors.join(", "), inStock: product.inStock, badge: product.badge || "" },
        });
        res.write(`✅ ${product.name}\n`);
      } catch (err) {
        res.write(`❌ Failed: ${product.name} - ${err.message}\n`);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (vectors.length > 0) {
      await index.upsert(vectors);
      res.write(`\n✅ Uploaded ${vectors.length} products to Pinecone!\nRAG is ready!\n`);
    } else {
      res.write("\n❌ No products embedded.\n");
    }
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;