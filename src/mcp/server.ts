#!/usr/bin/env node
/**
 * MCP server exposing the yumi.market client as tools for an assistant.
 * Transport: stdio. Never write to stdout here except through the transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClientFromEnv, YumiHttpError, type Cart, type RawCategoryTreeNode } from "../yumi/index.js";

const yumi = createClientFromEnv();

const server = new McpServer({ name: "yumi-market", version: "0.1.0" });

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const msg =
      err instanceof YumiHttpError
        ? `${err.message} (HTTP ${err.status})`
        : err instanceof Error
          ? err.message
          : String(err);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
}

function compactTree(nodes: RawCategoryTreeNode[]): unknown[] {
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    ...(n.children?.length ? { children: compactTree(n.children) } : {}),
  }));
}

function cartSummary(cart: Cart) {
  return {
    ...cart,
    note:
      cart.remainingForFreeDelivery && cart.remainingForFreeDelivery > 0
        ? `До безкоштовної доставки залишилось ${cart.remainingForFreeDelivery.toFixed(2)} ₴`
        : undefined,
  };
}

// ---------- Catalog ----------

server.registerTool(
  "search_products",
  {
    title: "Пошук товарів",
    description:
      "Search the yumi.market catalog (balloons and party goods). Returns products with id, sku, price in UAH, " +
      "wholesale tier prices (tierPrices: price per unit from minQty), stock and attributes (size, manufacturer, colour). " +
      "Use filters with option ids from get_category_filters. The site's text search is fuzzy (e.g. '12' does not " +
      "reliably mean 12\"), so for size/colour/manufacturer prefer filters (razmer_v_diuimax, cvet, proizvoditel).",
    inputSchema: {
      query: z.string().optional().describe("Free-text search, e.g. 'Gemar 12 пастель білий' or a SKU"),
      categoryId: z.number().int().optional().describe("Category id from list_categories"),
      filters: z
        .record(z.array(z.union([z.number(), z.string()])))
        .optional()
        .describe("Attribute filters: { attributeCode: [optionId, ...] }, e.g. { cvet: [577] }"),
      minPrice: z.number().optional(),
      maxPrice: z.number().optional(),
      sort: z
        .enum(["price-asc", "price-desc", "name-asc", "created_at-desc", "final_sale-desc", "exclusive-desc"])
        .optional()
        .describe("price-* scans up to 500 matches and sorts them; created_at-desc = newest first"),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(48).optional().describe("Page size (site default 24)"),
    },
  },
  (args) => run(() => yumi.searchProducts(args)),
);

server.registerTool(
  "get_product",
  {
    title: "Картка товару",
    description: "Full product card by URL key or product URL: description, SKU, image plus live price tiers and stock.",
    inputSchema: { urlKey: z.string().describe("e.g. 'gemar-dz-13-gb120-089-xrom-sribnii-shiny-silver' or full URL") },
  },
  ({ urlKey }) => run(() => yumi.getProduct(urlKey)),
);

server.registerTool(
  "find_by_sku",
  {
    title: "Товар за артикулом",
    description: "Find a product by its exact SKU (артикул).",
    inputSchema: { sku: z.string() },
  },
  ({ sku }) => run(async () => (await yumi.findBySku(sku)) ?? `SKU ${sku} not found`),
);

server.registerTool(
  "list_categories",
  {
    title: "Категорії",
    description: "Category tree of the catalog with ids (for search_products.categoryId).",
    inputSchema: {},
  },
  () => run(async () => compactTree(await yumi.getCategoryTree())),
);

server.registerTool(
  "get_category_filters",
  {
    title: "Фільтри категорії",
    description:
      "Filterable attributes of a category (size, manufacturer, colour...) with their option ids, for search_products.filters.",
    inputSchema: {
      categoryId: z.number().int(),
      attributeCode: z.string().optional().describe("Only this attribute, e.g. 'cvet'"),
    },
  },
  ({ categoryId, attributeCode }) =>
    run(async () => {
      const attrs = (await yumi.getCategoryFilters(categoryId)).filter(
        (a) => !attributeCode || a.code === attributeCode,
      );
      const out = [];
      for (const a of attrs) {
        const options = a.type === "price" ? [] : await yumi.getFilterOptions(a.id, categoryId).catch(() => []);
        out.push({ code: a.code, name: a.name, type: a.type, options });
      }
      return out;
    }),
);

// ---------- Cart ----------

server.registerTool(
  "get_cart",
  {
    title: "Кошик",
    description: "Current cart: lines (itemId, quantity, unit price after tier discounts), totals, free-delivery progress.",
    inputSchema: {},
  },
  () => run(async () => cartSummary(await yumi.getCart())),
);

server.registerTool(
  "add_to_cart",
  {
    title: "Додати в кошик",
    description:
      "Add a product to the cart by product id (from search_products). Adding a product already in the cart increases its quantity.",
    inputSchema: {
      productId: z.number().int(),
      quantity: z.number().int().min(1),
    },
  },
  ({ productId, quantity }) =>
    run(async () => {
      const r = await yumi.addToCart(productId, quantity);
      return { message: r.message, cart: cartSummary(r.cart) };
    }),
);

server.registerTool(
  "update_cart_item",
  {
    title: "Змінити кількість",
    description: "Set the quantity of a cart line (itemId from get_cart).",
    inputSchema: {
      itemId: z.number().int(),
      quantity: z.number().int().min(1),
    },
  },
  ({ itemId, quantity }) =>
    run(async () => {
      const r = await yumi.updateCartQuantities({ [itemId]: quantity });
      return { message: r.message, cart: cartSummary(r.cart) };
    }),
);

server.registerTool(
  "remove_cart_item",
  {
    title: "Видалити з кошика",
    description: "Remove a line from the cart (itemId from get_cart).",
    inputSchema: { itemId: z.number().int() },
  },
  ({ itemId }) =>
    run(async () => {
      const r = await yumi.removeCartItem(itemId);
      return { message: r.message, cart: cartSummary(r.cart) };
    }),
);

// ---------- Account ----------

server.registerTool(
  "auth_status",
  {
    title: "Статус входу",
    description: "Whether the stored session is signed in to the yumi.market customer account.",
    inputSchema: {},
  },
  () => run(async () => ({ loggedIn: await yumi.isLoggedIn() })),
);

server.registerTool(
  "login_send_code",
  {
    title: "Вхід: надіслати код",
    description:
      "Start signing in to yumi.market: the site e-mails a one-time code to the customer. Then ask the user for the code and call login_verify_code.",
    inputSchema: { email: z.string().email() },
  },
  ({ email }) =>
    run(async () => {
      await yumi.sendLoginCode(email);
      return "Код надіслано на пошту. Попросіть користувача повідомити код.";
    }),
);

server.registerTool(
  "login_verify_code",
  {
    title: "Вхід: підтвердити код",
    description: "Finish signing in with the one-time code the user received by e-mail.",
    inputSchema: { code: z.string().min(3).max(12) },
  },
  ({ code }) => run(() => yumi.verifyLoginCode(code)),
);

// ---------- Orders (require sign-in) ----------

server.registerTool(
  "list_orders",
  {
    title: "Мої замовлення",
    description: "Order history of the signed-in customer, newest first: id, number, date, status, total.",
    inputSchema: {
      page: z.number().int().min(1).optional(),
      perPage: z.number().int().min(1).max(50).optional(),
    },
  },
  ({ page, perPage }) => run(() => yumi.listOrders(page, perPage)),
);

server.registerTool(
  "get_order",
  {
    title: "Деталі замовлення",
    description:
      "Details of a past order (id from list_orders): items with SKU, name, price, quantity; totals; shipping and payment method.",
    inputSchema: { orderId: z.number().int() },
  },
  ({ orderId }) => run(() => yumi.getOrder(orderId)),
);

server.registerTool(
  "reorder",
  {
    title: "Повторити замовлення",
    description:
      "Put all items of a past order into the current cart (the site's 'repeat order'). Does NOT place an order. Returns the cart.",
    inputSchema: { orderId: z.number().int() },
  },
  ({ orderId }) => run(async () => cartSummary(await yumi.reorder(orderId))),
);

await server.connect(new StdioServerTransport());
console.error("yumi-market MCP server running on stdio");
