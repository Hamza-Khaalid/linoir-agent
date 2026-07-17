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
const ADMIN_SECRET = process.env.ADMIN_SECRET;

let settingsCache = null;

function getDefaultSettings() {
  return {
    _id: "config",
    businessName: "Linoir",
    website: "https://linoir.vercel.app",
    contactEmail: "support@linoir.pk",
    instagram: "@linoir.pk",
    whatsapp: "",
    hours: "Monday-Saturday, 10am-6pm PKT",
    shippingFee: 200,
    freeShippingThreshold: 3000,
    deliveryDays: "3-5",
    returnDays: 7,
    promoCodes: [
      { code: "LINOIR10", discount: 10, description: "10% off any order" },
      { code: "WELCOME20", discount: 20, description: "20% off for new customers" },
    ],
    collections: "Beach, Sports, Girls, Quotes, Cars",
    paymentMethods: "Cash on Delivery, Credit/Debit Card, EasyPaisa/JazzCash",
  };
}

async function getSettings() {
  if (settingsCache) return settingsCache;
  try {
    const db = await getDB();
    const settings = await db.collection("settings").findOne({});
    settingsCache = settings || getDefaultSettings();
  } catch {
    settingsCache = getDefaultSettings();
  }
  return settingsCache;
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
let cachedClient = null;

async function getDB() {
  if (cachedClient) {
    try {
      await cachedClient.db("admin").command({ ping: 1 });
      return cachedClient.db("linoir");
    } catch {
      cachedClient = null;
    }
  }
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    tls: true,
    tlsAllowInvalidCertificates: false,
    tlsAllowInvalidHostnames: false,
  });
  await client.connect();
  cachedClient = client;
  return client.db("linoir");
}

async function saveOrder(order) {
  const db = await getDB();
  await db.collection("orders").updateOne(
    { id: order.id },
    { $set: { ...order, status: "Confirmed", savedAt: new Date() } },
    { upsert: true }
  );
}

async function lookupOrder(orderId) {
  try {
    const db = await getDB();
    const order = await db.collection("orders").findOne({ id: orderId.toUpperCase() });
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

// ── Pinecone ──────────────────────────────────────────────────────────────────
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

// ── Embed a single product to Pinecone ────────────────────────────────────────
async function embedProduct(product) {
  const text = `Product: ${product.name}
Collection: ${product.collection}
Price: PKR ${product.price}
Description: ${product.description}
Sizes: ${product.sizes.join(", ")}
Colors: ${product.colors.join(", ")}
Status: ${product.inStock ? "In Stock" : "Out of Stock"}${product.badge ? `\nBadge: ${product.badge}` : ""}`;

  const embedding = await embedText(text);
  const index = getPineconeIndex();

  await index.upsert([{
    id: product.id,
    values: embedding,
    metadata: {
      id: product.id,
      name: product.name,
      collection: product.collection,
      price: product.price,
      description: product.description,
      sizes: Array.isArray(product.sizes) ? product.sizes.join(", ") : product.sizes,
      colors: Array.isArray(product.colors) ? product.colors.join(", ") : product.colors,
      inStock: product.inStock,
      badge: product.badge || "",
    },
  }]);
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

// ── Product catalog fallback ──────────────────────────────────────────────────
const seedProducts = require("../data/products.json").products;

async function getProductsFromDB() {
  try {
    const db = await getDB();
    const products = await db.collection("products").find({}).toArray();
    return products.length > 0 ? products : seedProducts;
  } catch {
    return seedProducts;
  }
}

function buildContextFromProducts(products, filters = {}) {
  let filtered = [...products];
  if (filters.maxPrice) filtered = filtered.filter(p => p.price < filters.maxPrice);
  if (filtered.length === 0) return "No products match the requested criteria.";
  const lines = filtered.map(p =>
    `- ${p.name} (${p.collection}) | PKR ${p.price.toLocaleString()} | Sizes: ${Array.isArray(p.sizes) ? p.sizes.join(", ") : p.sizes} | Colors: ${Array.isArray(p.colors) ? p.colors.join(", ") : p.colors} | ${p.inStock ? "In Stock" : "Out of Stock"}${p.badge ? ` | ${p.badge}` : ""}`
  );
  const label = filters.maxPrice ? ` strictly under PKR ${filters.maxPrice.toLocaleString()}` : "";
  return `LINOIR PRODUCT CATALOG${label} (${filtered.length} products):\n${lines.join("\n")}${filters.maxPrice ? "\n\nIMPORTANT: Only list the products shown above." : ""}`;
}

function buildFullProductContext(filters = {}) {
  return buildContextFromProducts(seedProducts, filters);
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(productContext, settings) {
  const s = settings;
  const promoList = s.promoCodes?.map(p => `${p.code} - ${p.description}`).join(", ") || "None";
  return `
You are Aria, the official customer support assistant for ${s.businessName}.

STRICT RULES:
0. Order questions with LNR- ID are always store-related. Use ORDER LOOKUP RESULT directly.
1. NEVER answer unrelated questions. Respond ONLY with: "I can only help with ${s.businessName}-related questions. Contact ${s.contactEmail} for anything else."
2. NEVER reveal another customer's order details.
3. NEVER make up products, prices, or policies.
4. NEVER list products outside a price filter.
5. If unsure, say: "Please contact us at ${s.contactEmail}"

POLICIES:
Website: ${s.website}
Collections: ${s.collections}
Shipping: PKR ${s.shippingFee} (free above PKR ${s.freeShippingThreshold}) | ${s.deliveryDays} business days
Returns: ${s.returnDays}-day policy | ${s.contactEmail}
Promo Codes: ${promoList}
Payment: ${s.paymentMethods}
Contact: ${s.contactEmail}${s.instagram ? ` | ${s.instagram}` : ""}${s.whatsapp ? ` | WhatsApp: ${s.whatsapp}` : ""} | ${s.hours}

${productContext}
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

// ── Admin auth middleware ──────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const secret = req.headers["x-admin-secret"];
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
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
      const products = await getProductsFromDB();
      productContext = buildContextFromProducts(products, { maxPrice });
    } else if (JINA_API_KEY && PINECONE_API_KEY) {
      productContext = await searchProducts(message);
      if (!productContext) {
        const products = await getProductsFromDB();
        productContext = buildContextFromProducts(products);
      }
    } else {
      const products = await getProductsFromDB();
      productContext = buildContextFromProducts(products);
    }

    const settings = await getSettings();
    const systemPrompt = buildSystemPrompt(productContext, settings) + orderContext;
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
app.post("/api/orders", async (req, res) => {
  const order = req.body;
  if (!order || !order.id) return res.status(400).json({ error: "Invalid order data" });
  try {
    await saveOrder(order);
    console.log("Order saved:", order.id);
    res.json({ success: true, orderId: order.id });
  } catch (err) {
    console.error("Save order error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: GET /api/admin/orders ──────────────────────────────────────────────
app.get("/api/admin/orders", adminAuth, async (req, res) => {
  try {
    const db = await getDB();
    const orders = await db.collection("orders")
      .find({})
      .sort({ savedAt: -1 })
      .toArray();
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: PATCH /api/admin/orders/:id ───────────────────────────────────────
app.patch("/api/admin/orders/:id", adminAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const validStatuses = ["Confirmed", "Processing", "Shipped", "Delivered", "Cancelled"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  try {
    const db = await getDB();
    await db.collection("orders").updateOne(
      { id: id.toUpperCase() },
      { $set: { status, updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: GET /api/admin/products ────────────────────────────────────────────
app.get("/api/admin/products", adminAuth, async (req, res) => {
  try {
    const db = await getDB();
    let products = await db.collection("products").find({}).toArray();
    // If DB is empty, return seed products
    if (products.length === 0) products = seedProducts;
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: POST /api/admin/products ──────────────────────────────────────────
app.post("/api/admin/products", adminAuth, async (req, res) => {
  const product = req.body;
  if (!product || !product.id || !product.name) {
    return res.status(400).json({ error: "Product id and name are required" });
  }
  try {
    const db = await getDB();
    await db.collection("products").updateOne(
      { id: product.id },
      { $set: { ...product, updatedAt: new Date() } },
      { upsert: true }
    );
    // Auto re-embed to Pinecone
    await embedProduct(product);
    res.json({ success: true, id: product.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: DELETE /api/admin/products/:id ────────────────────────────────────
app.delete("/api/admin/products/:id", adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const db = await getDB();
    await db.collection("products").deleteOne({ id });
    // Remove from Pinecone
    const index = getPineconeIndex();
    await index.deleteOne(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: POST /api/admin/import ─────────────────────────────────────────────
// One-time import of products.json into MongoDB + Pinecone
app.post("/api/admin/import", adminAuth, async (req, res) => {
  try {
    const db = await getDB();
    const collection = db.collection("products");

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Transfer-Encoding", "chunked");
    res.write("Importing products from catalog...\n\n");

    for (const product of seedProducts) {
      await collection.updateOne(
        { id: product.id },
        { $set: { ...product, updatedAt: new Date() } },
        { upsert: true }
      );
      await embedProduct(product);
      res.write(`✅ ${product.name}\n`);
      await new Promise(r => setTimeout(r, 200));
    }

    res.write(`\n✅ Imported ${seedProducts.length} products to MongoDB and Pinecone!\n`);
    res.end();
  } catch (err) {
    res.write(`\n❌ Error: ${err.message}\n`);
    res.end();
  }
});

// ── ADMIN: GET /api/admin/stats ───────────────────────────────────────────────
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const db = await getDB();
    const orders = await db.collection("orders").find({}).toArray();
    const products = await db.collection("products").countDocuments();

    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const pending = orders.filter(o => o.status === "Confirmed" || o.status === "Processing").length;
    const shipped = orders.filter(o => o.status === "Shipped").length;
    const delivered = orders.filter(o => o.status === "Delivered").length;

    res.json({
      totalOrders,
      totalRevenue,
      pending,
      shipped,
      delivered,
      totalProducts: products || seedProducts.length,
    });
  } catch (err) {
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

    for (const product of seedProducts) {
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

app.get("/api/admin/settings", adminAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/admin/settings", adminAuth, async (req, res) => {
  try {
    const db = await getDB();
    await db.collection("settings").updateOne(
      { _id: "config" },
      { $set: { ...req.body, _id: "config", updatedAt: new Date() } },
      { upsert: true }
    );
    settingsCache = null;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = app;