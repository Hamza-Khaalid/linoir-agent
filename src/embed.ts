// ─── EMBED & UPLOAD TO PINECONE ───────────────────────────────────────────────
// Run this ONCE to vectorize all products and store in Pinecone.
// Usage: ts-node src/embed.ts

import { Pinecone } from "@pinecone-database/pinecone";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
dotenv.config();

const HF_TOKEN = process.env.HF_TOKEN;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX = process.env.PINECONE_INDEX || "linoir-products";
const EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2";

// ── Get embedding from Hugging Face ──────────────────────────────────────────
async function getEmbedding(text: string): Promise<number[]> {
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
    const err = await response.text();
    throw new Error(`HF API error: ${err}`);
  }

  const data = await response.json() as number[][];
  return data[0];
}

// ── Build text representation of a product ────────────────────────────────────
function productToText(p: any): string {
  return `
Product: ${p.name}
Collection: ${p.collection}
Price: PKR ${p.price}
Description: ${p.description}
Available Sizes: ${p.sizes.join(", ")}
Available Colors: ${p.colors.join(", ")}
Status: ${p.inStock ? "In Stock" : "Out of Stock"}
${p.badge ? `Badge: ${p.badge}` : ""}
  `.trim();
}

async function main() {
  console.log("🚀 Starting product embedding...\n");

  // Load products
  const productsPath = path.resolve("./data/products.json");
  const products = JSON.parse(fs.readFileSync(productsPath, "utf8")).products;
  console.log(`📦 Found ${products.length} products\n`);

  // Init Pinecone
  const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY! });
  const index = pinecone.index(PINECONE_INDEX);

  // Embed and upload each product
  const vectors = [];

  for (const product of products) {
    const text = productToText(product);
    console.log(`⏳ Embedding: ${product.name}...`);

    try {
      const embedding = await getEmbedding(text);

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
          text, // full text for context
        },
      });

      console.log(`✅ ${product.name} embedded`);

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));

    } catch (err: any) {
      console.error(`❌ Failed to embed ${product.name}:`, err.message);
    }
  }

  // Upload all vectors to Pinecone
  console.log(`\n⏳ Uploading ${vectors.length} vectors to Pinecone...`);
  await index.upsert(vectors);
  console.log("✅ All products uploaded to Pinecone!\n");
  console.log("You can now use RAG in your backend.");
}

main().catch(console.error);