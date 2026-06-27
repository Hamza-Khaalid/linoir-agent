// ─── ORDER TOOL ───────────────────────────────────────────────────────────────
// Saves orders from the website and looks them up by ID.

import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
dotenv.config();

const ORDERS_PATH = path.resolve(process.env.ORDERS_PATH || "./data/orders.json");

function readOrders(): any[] {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_PATH, "utf8"));
  } catch {
    return [];
  }
}

function writeOrders(orders: any[]) {
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2));
}

export function saveOrder(order: any) {
  const orders = readOrders();
  // Avoid duplicates
  const exists = orders.find(o => o.id === order.id);
  if (!exists) {
    orders.push({ ...order, status: "Confirmed", createdAt: new Date().toISOString() });
    writeOrders(orders);
  }
}

export function lookupOrder(orderId: string): string {
  const orders = readOrders();
  const order = orders.find(o =>
    o.id?.toLowerCase() === orderId.toLowerCase()
  );

  if (!order) {
    return `No order found with ID "${orderId}". Please double-check your order number — it starts with LNR- followed by 6 digits.`;
  }

  const statusMap: Record<string, string> = {
    Confirmed: "✓ Confirmed — your order has been received.",
    Processing: "⚙ Processing — we are preparing your items.",
    Shipped: "🚚 Shipped — your order is on the way.",
    Delivered: "✅ Delivered — your order has arrived.",
    Cancelled: "✗ Cancelled.",
  };

  const itemList = order.items
    ?.map((i: any) => `${i.name} (${i.size}, ${i.color}) x${i.qty}`)
    .join(", ") || "N/A";

  return `
Order ${order.id}:
- Status: ${statusMap[order.status] || order.status}
- Date: ${order.date || new Date(order.createdAt).toLocaleDateString()}
- Items: ${itemList}
- Total: PKR ${order.total?.toLocaleString() || "N/A"}
- Shipping to: ${order.customer?.address || "N/A"}
- Estimated delivery: 3–5 business days from order date
  `.trim();
}
