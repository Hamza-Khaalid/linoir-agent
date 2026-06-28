// ─── VECTOR RAG ───────────────────────────────────────────────────────────────
// Searches Pinecone for relevant products based on the user's query.

import { Pinecone } from "@pinecone-database/pinecone";
import dotenv from "dotenv";
dotenv.config();

const HF_TOKEN = process.env.HF_TOKEN;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX = process.env.PINECONE_INDEX || "linoir-products";
const EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2";

let pineconeIndex: any = null;

function getPineconeIndex() {
  if (!pineconeIndex) {
    const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY! });
    pineconeIndex = pinecone.index(PINECONE_INDEX);
  }
  return pineconeIndex;
}

// ── Embed a query ─────────────────────────────────────────────────────────────
async function embedQuery(text: string): Promise<number[]> {
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

  if (!response.ok) {
    throw new Error(`HF embedding error: ${await response.text()}`);
  }

  const data = await response.json() as number[][];
  return data[0];
}

// ── Search Pinecone for relevant products ─────────────────────────────────────
export async function searchProducts(query: string, topK: number = 4): Promise<string> {
  try {
    const index = getPineconeIndex();
    const queryEmbedding = await embedQuery(query);

    const results = await index.query({
      vector: queryEmbedding,
      topK,
      includeMetadata: true,
    });

    if (!results.matches || results.matches.length === 0) {
      return "No relevant products found.";
    }

    const productLines = results.matches.map((match: any) => {
      const m = match.metadata;
      return `- ${m.name} (${m.collection} collection) | PKR ${m.price.toLocaleString()} | Sizes: ${m.sizes} | Colors: ${m.colors} | ${m.inStock ? "In Stock" : "Out of Stock"}${m.badge ? ` | ${m.badge}` : ""}`;
    });

    return `RELEVANT PRODUCTS FOR THIS QUERY (${results.matches.length} found):\n${productLines.join("\n")}`;

  } catch (err: any) {
    console.error("Vector search error:", err.message);
    // Fallback — return empty so the system prompt still has base context
    return "";
  }
}