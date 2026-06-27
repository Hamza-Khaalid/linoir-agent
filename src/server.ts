// ─── LINOIR AGENT BACKEND — GROQ ─────────────────────────────────────────────

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { buildProductContext, buildFilteredProductContext } from "./rag";
import { saveOrder, lookupOrder } from "./orders";
import { buildSystemPrompt } from "./prompt";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "gemma2-9b-it"; // Gemma 2 on Groq — fast and free

app.use(cors());
app.use(express.json());

// ── Groq API call ──────────────────────────────────────────────────────────────
async function callGroq(messages: { role: string; content: string }[]): Promise<string> {
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

  const data = await response.json() as any;
  return data.choices[0].message.content.trim();
}

// ── POST /api/chat ─────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: "GROQ_API_KEY not configured" });
  }

  try {
    // 1 — Order lookup
    const orderMatch = message.match(/LNR[-\s]?\d+/i);
    let orderContext = "";
    if (orderMatch) {
      const orderId = orderMatch[0].replace(/\s/, "-").toUpperCase();
      const result = lookupOrder(orderId);
      orderContext = `\n\nORDER LOOKUP RESULT FOR ${orderId}:\n${result}\n\nThis is a Linoir order query. Use the result above to answer directly.`;
    }

    // 2 — Price filter detection — filter in code, not by AI
    const priceMatch = message.match(/under\s+PKR?\s*([\d,]+)|below\s+PKR?\s*([\d,]+)|less\s+than\s+PKR?\s*([\d,]+)/i);
    let productContext: string;

    if (priceMatch) {
      const rawAmount = (priceMatch[1] || priceMatch[2] || priceMatch[3]).replace(/,/g, "");
      const maxPrice = parseInt(rawAmount);
      productContext = buildFilteredProductContext({ maxPrice });
    } else {
      productContext = buildProductContext();
    }

    // 3 — Build system prompt
    const systemPrompt = buildSystemPrompt(productContext) + orderContext;

    // 4 — Build messages
    const messages_arr = [
      { role: "system", content: systemPrompt },
      ...history.slice(-8),
      { role: "user", content: message }
    ];

    // 5 — Call Groq
    const reply = await callGroq(messages_arr);
    res.json({ reply });

  } catch (err: any) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ── POST /api/orders ───────────────────────────────────────────────────────────
app.post("/api/orders", (req, res) => {
  const order = req.body;
  if (!order || !order.id) {
    return res.status(400).json({ error: "Invalid order data" });
  }
  try {
    saveOrder(order);
    res.json({ success: true, orderId: order.id });
  } catch (err: any) {
    res.status(500).json({ error: "Could not save order" });
  }
});

// ── GET /api/health ────────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => {
  res.json({ status: "ok", model: GROQ_MODEL, provider: "groq" });
});

app.listen(PORT, () => {
  console.log(`\n🟢 Linoir Agent running on http://localhost:${PORT}`);
  console.log(`   Model: ${GROQ_MODEL} via Groq`);
  console.log(`   POST /api/chat    — chat endpoint`);
  console.log(`   POST /api/orders  — save order`);
  console.log(`   GET  /api/health  — health check\n`);
});