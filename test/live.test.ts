/**
 * Live end-to-end tests against yumi.market through the MCP server (what the assistant uses)
 * and the REST API. They use the saved session (npm run login) and leave the cart as they found it.
 *
 *   npm run test:live
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/app.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

let client: Client;
let loggedIn = false;
let initialCartItemIds = new Set<number>();
let initialWishlistProductIds = new Set<number>();

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(name: string, args: Record<string, unknown> = {}): Promise<Json> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  const t = r.content[0].text;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(r.isError, true, `${name} should fail`);
  return r.content[0].text;
}

/** Remove wishlist entries that were not there before the tests. */
async function cleanupWishlist() {
  if (!loggedIn) return;
  const w = await call("get_wishlist");
  for (const item of w.items) {
    if (!initialWishlistProductIds.has(item.productId)) await call("remove_from_wishlist", { wishlistId: item.wishlistId });
  }
}

/** Remove cart lines that were not there before the tests. */
async function cleanupCart() {
  const cart = await call("get_cart");
  for (const item of cart.items) {
    if (!initialCartItemIds.has(item.itemId)) await call("remove_cart_item", { itemId: item.itemId });
  }
}

describe("yumi.market live", () => {
before(async () => {
  client = new Client({ name: "live-test", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [tsxCli, "src/mcp/server.ts"], cwd: root, stderr: "ignore" }),
  );
  loggedIn = (await call("auth_status")).loggedIn;
  const cart = await call("get_cart");
  initialCartItemIds = new Set(cart.items.map((i: Json) => i.itemId));
  if (loggedIn) {
    const w = await call("get_wishlist");
    initialWishlistProductIds = new Set(w.items.map((i: Json) => i.productId));
  }
});

after(async () => {
  await cleanupCart().catch(() => undefined);
  await cleanupWishlist().catch(() => undefined);
  await client?.close();
});

describe("MCP: tools", () => {
  test("exposes all expected tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const n of [
      "search_products", "get_product", "get_product_images", "find_by_sku", "list_categories", "get_category_filters",
      "get_cart", "add_to_cart", "update_cart_item", "remove_cart_item",
      "auth_status", "login_send_code", "login_verify_code", "list_orders", "get_order", "reorder",
      "get_wishlist", "add_to_wishlist", "remove_from_wishlist", "move_wishlist_item_to_cart", "move_cart_item_to_wishlist",
    ]) assert.ok(names.includes(n), `missing tool ${n}`);
  });
});

describe("Catalog", () => {
  let latexId: number;
  let whiteId: number;

  test("list_categories returns the tree with latex balloons", async () => {
    const tree = await call("list_categories");
    assert.ok(tree.length > 5);
    const latex = tree.find((c: Json) => /Латексні/i.test(c.name));
    assert.ok(latex, "no 'Латексні Кулі' category");
    latexId = latex.id;
  });

  test("get_category_filters returns colour options", async () => {
    const filters = await call("get_category_filters", { categoryId: latexId, attributeCode: "cvet" });
    assert.equal(filters.length, 1);
    const white = filters[0].options.find((o: Json) => o.name === "Білий");
    assert.ok(white, "no colour 'Білий'");
    whiteId = white.id;
  });

  test("free-text search finds Gemar balloons with prices", async () => {
    const r = await call("search_products", { query: "gemar", limit: 10 });
    assert.ok(r.total > 50, `only ${r.total} results`);
    assert.ok(r.items.length > 0 && r.items.length <= 24);
    for (const p of r.items) {
      assert.match(p.name, /gemar/i);
      assert.ok(p.price > 0, `${p.sku} has no price`);
      assert.ok(Number.isInteger(p.id));
    }
  });

  test("Ukrainian query works", async () => {
    const r = await call("search_products", { query: "фольгована зірка" });
    assert.ok(r.total > 0, "no results for 'фольгована зірка'");
  });

  test("category + colour filter narrows results", async () => {
    const all = await call("search_products", { categoryId: latexId });
    const white = await call("search_products", { categoryId: latexId, filters: { cvet: [whiteId] } });
    assert.ok(white.total > 0 && white.total < all.total, `white=${white.total} all=${all.total}`);
  });

  test("sort by price ascending / descending", async () => {
    const asc = await call("search_products", { categoryId: latexId, sort: "price-asc", limit: 24 });
    const desc = await call("search_products", { categoryId: latexId, sort: "price-desc", limit: 24 });
    const a = asc.items.map((p: Json) => p.price);
    const d = desc.items.map((p: Json) => p.price);
    assert.deepEqual(a, [...a].sort((x, y) => x - y), `not ascending: ${a.join(",")}`);
    assert.deepEqual(d, [...d].sort((x, y) => y - x), `not descending: ${d.join(",")}`);
    assert.ok(a[0] <= d[0]);
  });

  test("price range filter", async () => {
    const r = await call("search_products", { categoryId: latexId, minPrice: 5, maxPrice: 10 });
    assert.ok(r.total > 0);
    for (const p of r.items) assert.ok(p.price >= 4.99 && p.price <= 10.01, `${p.sku} price ${p.price} out of range`);
  });

  test("pagination returns different pages", async () => {
    const p1 = await call("search_products", { query: "gemar", page: 1 });
    const p2 = await call("search_products", { query: "gemar", page: 2 });
    assert.equal(p2.page, 2);
    const ids1 = new Set(p1.items.map((p: Json) => p.id));
    assert.ok(p2.items.every((p: Json) => !ids1.has(p.id)), "page 2 repeats page 1");
  });

  test("wholesale tier prices are exposed", async () => {
    const r = await call("search_products", { query: "gemar 12", categoryId: latexId, filters: { cvet: [whiteId] } });
    const withTiers = r.items.find((p: Json) => p.tierPrices.length > 0);
    assert.ok(withTiers, "no product with tier prices");
    assert.ok(withTiers.tierPrices[0].price < withTiers.price);
  });

  test("find_by_sku and get_product agree with search", async () => {
    const r = await call("search_products", { query: "gemar", limit: 5 });
    const p = r.items[0];
    const bySku = await call("find_by_sku", { sku: p.sku });
    assert.equal(bySku.id, p.id);
    const card = await call("get_product", { urlKey: p.url });
    assert.equal(card.id, p.id);
    assert.equal(card.sku, p.sku);
    assert.ok(card.description && card.description.length > 10, "no description");
    assert.equal(card.listing.price, p.price);
  });

  test("get_product includes the photo gallery", async () => {
    const card = await call("get_product", { urlKey: "gemar-dz-13-gb120-089-xrom-sribnii-shiny-silver" });
    assert.ok(card.images.length >= 1, "no images");
    for (const img of card.images) {
      for (const s of ["small", "medium", "large", "original"]) assert.match(img[s], /^https:\/\/yumi\.market\/.+\.(webp|jpe?g|png)$/);
    }
  });

  test("get_product_images returns viewable images (by urlKey and by SKU)", async () => {
    const r = (await client.callTool({
      name: "get_product_images",
      arguments: { urlKey: "gemar-dz-13-gb120-089-xrom-sribnii-shiny-silver", max: 2 },
    })) as { isError?: boolean; content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> };
    assert.ok(!r.isError, r.content[0].text);
    const images = r.content.filter((c) => c.type === "image");
    assert.equal(images.length, 2);
    for (const img of images) {
      assert.match(img.mimeType!, /^image\//);
      const bytes = Buffer.from(img.data!, "base64");
      assert.ok(bytes.length > 500, "image too small");
      if (img.mimeType === "image/webp") assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP");
    }
    const info = JSON.parse(r.content[0].text!);
    assert.ok(info.totalImages >= 2 && info.name);

    const bySku = (await client.callTool({ name: "get_product_images", arguments: { sku: "73712", max: 1, size: "small" } })) as {
      isError?: boolean;
      content: Array<{ type: string }>;
    };
    assert.ok(!bySku.isError);
    assert.equal(bySku.content.filter((c) => c.type === "image").length, 1);
  });

  test("get_product_images needs a product reference", async () => {
    assert.match(await callError("get_product_images", {}), /urlKey or sku/);
  });

  test("unknown SKU and product are handled", async () => {
    assert.match(await call("find_by_sku", { sku: "no-such-sku-000" }), /not found/);
    assert.match(await callError("get_product", { urlKey: "no-such-product-xyz-123" }), /404/);
  });
});

describe("Cart", () => {
  let product: Json;
  let itemId: number;

  before(async () => {
    const r = await call("search_products", { query: "gemar 12 пастель білий" });
    product = r.items.find((p: Json) => p.saleable && p.inStock > 200 && p.tierPrices.length > 0) ?? r.items[0];
    assert.ok(product, "no product to test with");
  });

  test("add_to_cart adds a line", async () => {
    const r = await call("add_to_cart", { productId: product.id, quantity: 3 });
    const line = r.cart.items.find((i: Json) => i.urlKey === product.urlKey);
    assert.ok(line, "line not in cart");
    assert.equal(line.quantity, 3);
    assert.equal(line.unitPrice, product.price);
    itemId = line.itemId;
    if (loggedIn) assert.equal(r.cart.isGuest, false, "cart should belong to the account");
  });

  test("adding the same product again increases quantity", async () => {
    const r = await call("add_to_cart", { productId: product.id, quantity: 2 });
    assert.equal(r.cart.items.find((i: Json) => i.itemId === itemId).quantity, 5);
  });

  test("update_cart_item to a wholesale quantity applies the tier price", async () => {
    const tier = product.tierPrices[0];
    if (!tier) return;
    const r = await call("update_cart_item", { itemId, quantity: tier.minQty });
    const line = r.cart.items.find((i: Json) => i.itemId === itemId);
    assert.equal(line.quantity, tier.minQty);
    assert.equal(line.unitPrice, tier.price);
    assert.ok(Math.abs(line.total - tier.price * tier.minQty) < 0.05);
  });

  test("get_cart shows totals and free-delivery progress", async () => {
    const cart = await call("get_cart");
    assert.ok(cart.grandTotal > 0);
    assert.ok(cart.freeDeliveryThreshold > 0);
    assert.ok(typeof cart.note === "string" || cart.remainingForFreeDelivery === 0);
  });

  test("remove_cart_item removes the line", async () => {
    const r = await call("remove_cart_item", { itemId });
    assert.ok(!r.cart.items.some((i: Json) => i.itemId === itemId));
  });

  test("invalid product id is reported as an error", async () => {
    await callError("add_to_cart", { productId: 999999999, quantity: 1 });
  });
});

describe("Orders (signed in)", () => {
  test("list_orders returns history", async (t) => {
    if (!loggedIn) return t.skip("not signed in (npm run login)");
    const r = await call("list_orders", { perPage: 50 });
    assert.ok(r.total > 0);
    for (const o of r.items) {
      assert.match(o.number, /^ua\d+/);
      assert.ok(o.grandTotal > 0);
      assert.ok(o.status.length > 0);
    }
  });

  test("get_order lines add up to the order total", async (t) => {
    if (!loggedIn) return t.skip("not signed in");
    const { items } = await call("list_orders", { perPage: 50 });
    for (const o of items.slice(0, 5)) {
      const d = await call("get_order", { orderId: o.id });
      assert.ok(d.items.length > 0, `${o.number}: no lines`);
      const sum = d.items.reduce((s: number, i: Json) => s + i.total, 0);
      assert.ok(Math.abs(sum - d.subTotal) < 0.05, `${o.number}: lines ${sum} != subtotal ${d.subTotal}`);
      assert.ok(Math.abs(d.grandTotal - o.grandTotal) < 0.05, `${o.number}: ${d.grandTotal} != ${o.grandTotal}`);
      for (const i of d.items) assert.ok(i.sku && i.name && i.quantity > 0, `${o.number}: bad line ${JSON.stringify(i)}`);
    }
  });

  test("reorder puts a past order's items into the cart", async (t) => {
    if (!loggedIn) return t.skip("not signed in");
    const { items } = await call("list_orders", { perPage: 50 });
    // smallest order with few lines
    const details = [];
    for (const o of items.slice(0, 5)) details.push(await call("get_order", { orderId: o.id }));
    const order = details.sort((a, b) => a.items.length - b.items.length)[0];
    const cart = await call("reorder", { orderId: order.id });
    const names = cart.items.map((i: Json) => i.name);
    for (const line of order.items) {
      assert.ok(names.includes(line.name), `'${line.name}' not in cart after reorder`);
    }
    await cleanupCart();
    const after = await call("get_cart");
    assert.equal(after.items.filter((i: Json) => !initialCartItemIds.has(i.itemId)).length, 0);
  });
});

describe("Wishlist (signed in)", () => {
  let products: Json[] = [];

  before(async () => {
    if (!loggedIn) return;
    const r = await call("search_products", { query: "бантик", limit: 48 });
    products = r.items.filter((p: Json) => p.saleable && !initialWishlistProductIds.has(p.id)).slice(0, 3);
  });

  test("get_wishlist returns entries with product data", async (t) => {
    if (!loggedIn) return t.skip("not signed in");
    const w = await call("get_wishlist");
    assert.equal(w.count, w.items.length);
    for (const i of w.items) assert.ok(i.wishlistId && i.productId && i.name && i.price >= 0);
  });

  test("add_to_wishlist adds and is idempotent", async (t) => {
    if (!loggedIn) return t.skip("not signed in");
    const p = products[0];
    const r1 = await call("add_to_wishlist", { productId: p.id });
    assert.equal(r1.added, true);
    assert.ok(r1.wishlist.items.some((i: Json) => i.productId === p.id));
    const r2 = await call("add_to_wishlist", { productId: p.id });
    assert.equal(r2.added, false, "second add must not toggle it off");
    assert.ok(r2.wishlist.items.some((i: Json) => i.productId === p.id), "item disappeared after second add");
  });

  test("remove_from_wishlist removes only that entry", async (t) => {
    if (!loggedIn) return t.skip("not signed in");
    const p = products[0];
    const before = await call("get_wishlist");
    const entry = before.items.find((i: Json) => i.productId === p.id);
    const r = await call("remove_from_wishlist", { wishlistId: entry.wishlistId });
    assert.ok(!r.wishlist.items.some((i: Json) => i.productId === p.id));
    assert.equal(r.wishlist.count, before.count - 1);
  });

  test("move_wishlist_item_to_cart puts it in the cart", async (t) => {
    if (!loggedIn) return t.skip("not signed in");
    const p = products[1];
    await call("add_to_wishlist", { productId: p.id });
    const entry = (await call("get_wishlist")).items.find((i: Json) => i.productId === p.id);
    const r = await call("move_wishlist_item_to_cart", { wishlistId: entry.wishlistId, quantity: 2 });
    const line = r.cart.items.find((i: Json) => i.urlKey === p.urlKey);
    assert.ok(line, "not in cart");
    assert.equal(line.quantity, 2);
    await cleanupCart();
    await cleanupWishlist();
  });

  test("move_cart_item_to_wishlist moves a cart line", async (t) => {
    if (!loggedIn) return t.skip("not signed in");
    const p = products[2];
    const added = await call("add_to_cart", { productId: p.id, quantity: 1 });
    const line = added.cart.items.find((i: Json) => i.urlKey === p.urlKey);
    const r = await call("move_cart_item_to_wishlist", { itemId: line.itemId });
    assert.ok(!r.cart.items.some((i: Json) => i.itemId === line.itemId), "still in cart");
    const w = await call("get_wishlist");
    assert.ok(w.items.some((i: Json) => i.productId === p.id), "not in wishlist");
    await cleanupWishlist();
  });

  test("wishlist is back to its original state", async (t) => {
    if (!loggedIn) return t.skip("not signed in");
    const w = await call("get_wishlist");
    assert.deepEqual(new Set(w.items.map((i: Json) => i.productId)), initialWishlistProductIds);
  });
});

describe("REST API", () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  test("GET /catalog/products", async () => {
    const r = await fetch(`${base}/catalog/products?query=gemar&limit=3`);
    assert.equal(r.status, 200);
    assert.ok((await r.json()).total > 0);
  });

  test("POST/PATCH/DELETE /cart/items", async () => {
    const s = await (await fetch(`${base}/catalog/products?query=gemar%2012`)).json();
    const p = s.items.find((x: Json) => x.saleable);
    const add = await (await fetch(`${base}/cart/items`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: p.id, quantity: 1 }),
    })).json();
    const line = add.cart.items.find((i: Json) => i.urlKey === p.urlKey);
    const patch = await fetch(`${base}/cart/items/${line.itemId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quantity: 4 }),
    });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).cart.items.find((i: Json) => i.itemId === line.itemId).quantity, 4);
    const del = await fetch(`${base}/cart/items/${line.itemId}`, { method: "DELETE" });
    assert.equal(del.status, 200);
  });

  test("GET /catalog/products/:urlKey/images and /image", async () => {
    const key = "gemar-dz-13-gb120-089-xrom-sribnii-shiny-silver";
    const list = await (await fetch(`${base}/catalog/products/${key}/images`)).json();
    assert.ok(list.images.length >= 1);
    const img = await fetch(`${base}/catalog/products/${key}/image?index=1&size=medium`);
    assert.equal(img.status, 200);
    assert.match(img.headers.get("content-type") ?? "", /^image\//);
    assert.ok((await img.arrayBuffer()).byteLength > 500);
    assert.equal((await fetch(`${base}/catalog/products/${key}/image?index=99`)).status, 404);
    assert.equal((await fetch(`${base}/catalog/products/${key}/image?size=huge`)).status, 400);
  });

  test("image download refuses other hosts", async () => {
    const { createClientFromEnv } = await import("../src/yumi/index.js");
    await assert.rejects(createClientFromEnv().downloadImage("https://example.com/a.webp"), /Refusing/);
  });

  test("validation errors return 400", async () => {
    const r = await fetch(`${base}/cart/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 400);
    assert.equal((await fetch(`${base}/orders/abc`)).status, 400);
  });

  test("GET /orders", async (t) => {
    if (!loggedIn) return t.skip("not signed in");
    const r = await fetch(`${base}/orders`);
    assert.equal(r.status, 200);
    assert.ok((await r.json()).total > 0);
  });
});
});
