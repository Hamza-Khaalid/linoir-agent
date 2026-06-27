import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
dotenv.config();

interface Product {
  id: string;
  name: string;
  collection: string;
  price: number;
  description: string;
  sizes: string[];
  colors: string[];
  badge: string | null;
  inStock: boolean;
}

interface FilterOptions {
  maxPrice?: number;
  minPrice?: number;
  collection?: string;
  size?: string;
  color?: string;
}

function loadProducts(): Product[] {
  try {
    const filePath = path.resolve(process.env.PRODUCTS_PATH || "../linoir/data/products.json");
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw).products;
  } catch (err) {
    console.error("Could not load products.json:", err);
    return [];
  }
}

function productsToContext(products: Product[], label?: string): string {
  if (products.length === 0) {
    return "No products match the requested criteria.";
  }

  const lines = products.map(p =>
    `- ${p.name} (${p.collection}) | PKR ${p.price.toLocaleString()} | Sizes: ${p.sizes.join(", ")} | Colors: ${p.colors.join(", ")} | ${p.inStock ? "In Stock" : "Out of Stock"}${p.badge ? ` | ${p.badge}` : ""}`
  );

  return `
LINOIR PRODUCT CATALOG${label ? ` — ${label}` : ""} (${products.length} products):
${lines.join("\n")}
  `.trim();
}

export function buildProductContext(): string {
  const products = loadProducts();
  return productsToContext(products);
}

export function buildFilteredProductContext(filters: FilterOptions): string {
  let products = loadProducts();

  if (filters.maxPrice !== undefined) {
    products = products.filter(p => p.price < filters.maxPrice!);
  }
  if (filters.minPrice !== undefined) {
    products = products.filter(p => p.price > filters.minPrice!);
  }
  if (filters.collection) {
    products = products.filter(p => p.collection === filters.collection);
  }
  if (filters.size) {
    products = products.filter(p => p.sizes.includes(filters.size!));
  }
  if (filters.color) {
    products = products.filter(p =>
      p.colors.some(c => c.toLowerCase().includes(filters.color!.toLowerCase()))
    );
  }

  const label = filters.maxPrice ? `strictly under PKR ${filters.maxPrice.toLocaleString()}` : undefined;
  return productsToContext(products, label) +
    "\n\nIMPORTANT: Only list the products shown above. These are the ONLY products matching the customer's filter.";
}