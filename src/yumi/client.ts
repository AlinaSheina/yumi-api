import { findForm, parseRoots } from "./html.js";
import { YumiHttp, YumiHttpError, type YumiHttpOptions } from "./http.js";
import { mapOrderGrid, parseOrderPage, type OrderDetails, type OrderPage, type RawOrderGrid } from "./orders.js";
import type {
  Cart,
  Product,
  ProductDetails,
  ProductPage,
  RawCart,
  RawCartResponse,
  RawCategory,
  RawCategoryTreeNode,
  RawFilterAttribute,
  RawProduct,
  RawProductList,
  RawTierPrice,
  SearchParams,
  TierPrice,
} from "./types.js";

export { YumiHttpError };

/** Max products scanned when sorting by price (the site cannot sort by price itself). */
const PRICE_SORT_MAX_ITEMS = 500;

/**
 * Client for yumi.market built on the site's own shop API
 * (the same JSON endpoints its storefront uses).
 */
export class YumiClient {
  readonly http: YumiHttp;

  constructor(opts: YumiHttpOptions | YumiHttp = {}) {
    this.http = opts instanceof YumiHttp ? opts : new YumiHttp(opts);
  }

  // ---------- Catalog ----------

  async searchProducts(params: SearchParams = {}): Promise<ProductPage> {
    if (params.sort === "price-asc" || params.sort === "price-desc") {
      return this.searchSortedByPrice(params, params.sort);
    }
    return this.fetchProductPage(params);
  }

  /**
   * The site has no price sorting, so collect up to PRICE_SORT_MAX_ITEMS matching
   * products, sort them here and return the requested page.
   */
  private async searchSortedByPrice(params: SearchParams, sort: "price-asc" | "price-desc"): Promise<ProductPage> {
    const batch = 100;
    const all: Product[] = [];
    let total = 0;
    for (let page = 1; all.length < PRICE_SORT_MAX_ITEMS; page++) {
      const res = await this.fetchProductPage({ ...params, sort: undefined, page, limit: batch });
      total = res.total;
      all.push(...res.items);
      if (page >= res.lastPage) break;
    }
    all.sort((a, b) => (sort === "price-asc" ? a.price - b.price : b.price - a.price));

    const perPage = params.limit ?? 24;
    const page = params.page ?? 1;
    return {
      items: all.slice((page - 1) * perPage, page * perPage),
      page,
      lastPage: Math.max(1, Math.ceil(all.length / perPage)),
      perPage,
      total,
      ...(all.length < total
        ? { note: `Sorted by price among the first ${all.length} of ${total} matches; narrow the search for exact results.` }
        : {}),
    };
  }

  private async fetchProductPage(params: SearchParams): Promise<ProductPage> {
    const query: Record<string, string | number | undefined> = {
      query: params.query,
      category_id: params.categoryId,
      sort: params.sort,
      page: params.page,
      limit: params.limit,
    };
    if (params.minPrice !== undefined || params.maxPrice !== undefined) {
      query.price = `${params.minPrice ?? 0},${params.maxPrice ?? 1_000_000}`;
    }
    for (const [code, values] of Object.entries(params.filters ?? {})) {
      if (values.length) query[code] = values.join(",");
    }
    const res = await this.http.getJson<RawProductList>("/api/products", query);
    const p = res.meta.pagination;
    return {
      items: res.data.map((r) => this.toProduct(r)),
      page: p.current_page,
      lastPage: p.last_page,
      perPage: p.per_page,
      total: p.total,
    };
  }

  /** Find a product by exact SKU (the site's search matches SKUs). */
  async findBySku(sku: string): Promise<Product | undefined> {
    const res = await this.searchProducts({ query: sku, limit: 24 });
    return res.items.find((p) => p.sku === sku);
  }

  /** Full product card by its URL key (the part after yumi.market/). */
  async getProduct(urlKey: string): Promise<ProductDetails> {
    const key = urlKey.replace(/^https?:\/\/[^/]+\//, "").replace(/^\/+|\/+$/g, "");
    const html = await this.http.getHtml(`/${encodeURIComponent(key)}`);

    const idMatch = html.match(/\/api\/products\/(\d+)\/(?:related|up-sell|stock-alert)/);
    let ld: { name?: string; sku?: string; description?: string; image?: string | string[] } = {};
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try {
        const parsed = JSON.parse(m[1]);
        if (parsed?.["@type"] === "Product") {
          ld = parsed;
          break;
        }
      } catch {
        /* ignore malformed blocks */
      }
    }

    const details: ProductDetails = {
      id: idMatch ? Number(idMatch[1]) : null,
      urlKey: key,
      url: `${this.http.baseUrl}/${key}`,
      name: ld.name ?? key,
      sku: ld.sku,
      description: ld.description ? htmlToText(ld.description) : undefined,
      image: Array.isArray(ld.image) ? ld.image[0] : ld.image,
    };
    if (details.sku) details.listing = await this.findBySku(details.sku);
    return details;
  }

  async getCategories(): Promise<RawCategory[]> {
    const res = await this.http.getJson<{ data: RawCategory[] }>("/api/categories");
    return res.data;
  }

  async getCategoryTree(): Promise<RawCategoryTreeNode[]> {
    const res = await this.http.getJson<{ data: RawCategoryTreeNode[] }>("/api/categories/tree");
    return res.data;
  }

  /** Filterable attributes of a category (colour, size, manufacturer...). */
  async getCategoryFilters(categoryId: number): Promise<RawFilterAttribute[]> {
    const res = await this.http.getJson<{ data: RawFilterAttribute[] }>("/api/categories/attributes", {
      category_id: categoryId,
    });
    return res.data;
  }

  /** Options (with ids usable in SearchParams.filters) for one filter attribute. */
  async getFilterOptions(attributeId: number, categoryId?: number): Promise<Array<{ id: number; name: string }>> {
    const res = await this.http.getJson<{ data: Array<{ id: number; name: string }> }>(
      `/api/categories/attributes/${attributeId}/options`,
      { category_id: categoryId },
    );
    return res.data;
  }

  async searchSuggestions(q: string): Promise<string[]> {
    const res = await this.http.getJson<{ data: Array<{ term: string }> }>("/api/search/suggestions", { q });
    return res.data.map((s) => s.term);
  }

  // ---------- Cart ----------

  async getCart(): Promise<Cart> {
    const res = await this.http.getJson<RawCartResponse>("/api/checkout/cart");
    return this.toCart(res.data);
  }

  async addToCart(productId: number, quantity: number): Promise<{ message?: string; cart: Cart }> {
    const res = await this.http.sendJson<RawCartResponse>("POST", "/api/checkout/cart", {
      product_id: productId,
      quantity,
    });
    return { message: res.message, cart: this.toCart(res.data) };
  }

  /** Set quantities for existing cart lines: { [cartItemId]: newQty }. */
  async updateCartQuantities(qty: Record<number, number>): Promise<{ message?: string; cart: Cart }> {
    const res = await this.http.sendJson<RawCartResponse>("PUT", "/api/checkout/cart", { qty });
    return { message: res.message, cart: this.toCart(res.data) };
  }

  async removeCartItem(cartItemId: number): Promise<{ message?: string; cart: Cart }> {
    const res = await this.http.sendJson<RawCartResponse>("POST", "/api/checkout/cart", {
      _method: "DELETE",
      cart_item_id: cartItemId,
    });
    return { message: res.message, cart: this.toCart(res.data) };
  }

  // ---------- Account ----------

  /** True when the stored session belongs to a signed-in customer. */
  async isLoggedIn(): Promise<boolean> {
    const res = await this.http.request("GET", "/customer/account/profile", {
      accept: "html",
      redirect: "manual",
    });
    await res.arrayBuffer();
    return res.status === 200;
  }

  /**
   * Step 1 of sign-in: the site e-mails a one-time code to this address.
   * Returns the names of the fields the verification form expects.
   */
  async sendLoginCode(email: string): Promise<{ sent: boolean; codeFields: string[] }> {
    const loginHtml = await this.http.getHtml("/customer/login");
    const form = findForm(parseRoots(loginHtml), (a) => a.includes("/customer/otp/send"));
    if (!form) throw new Error("Login form not found on /customer/login");
    const token = form.fields.find((f) => f.name === "_token")?.value ?? "";

    const res = await this.http.postForm(new URL(form.action).pathname, { _token: token, email }, "html");
    await res.arrayBuffer();
    const location = res.headers.get("location") ?? "";
    if (!(res.status >= 300 && res.status < 400 && location.includes("/otp/verify"))) {
      throw new Error(`Code was not sent (HTTP ${res.status}${location ? ` -> ${location}` : ""}). Check the e-mail address.`);
    }
    const verify = await this.getVerifyForm();
    return { sent: true, codeFields: verify.codeFields };
  }

  /** Step 2 of sign-in: submit the code from the e-mail. */
  async verifyLoginCode(code: string): Promise<{ loggedIn: boolean }> {
    const { form, codeFields } = await this.getVerifyForm();
    const data: Record<string, string> = {};
    for (const f of form.fields) if (!codeFields.includes(f.name)) data[f.name] = f.value;
    const digits = code.replace(/\s+/g, "");
    if (codeFields.length === 1) data[codeFields[0]] = digits;
    else codeFields.forEach((name, i) => (data[name] = digits[i] ?? ""));

    const res = await this.http.postForm(new URL(form.action).pathname, data, "html");
    await res.arrayBuffer();
    return { loggedIn: await this.isLoggedIn() };
  }

  async logout(): Promise<void> {
    await this.http.clearSession();
  }

  private async getVerifyForm() {
    const html = await this.http.getHtml("/customer/otp/verify");
    const form = findForm(parseRoots(html), (a) => /\/otp\//.test(a) && !a.includes("/otp/send") && !/resend/.test(a));
    if (!form) throw new Error("No pending code: call sendLoginCode first (or the code expired).");
    const codeFields = form.fields
      .filter((f) => f.name !== "_token" && f.name !== "email" && f.type !== "hidden" && f.type !== "button" && f.type !== "submit")
      .map((f) => f.name);
    if (!codeFields.length) throw new Error("Could not find the code input on the verification form.");
    return { form, codeFields };
  }

  // ---------- Orders ----------

  async listOrders(page = 1, perPage = 10): Promise<OrderPage> {
    const raw = await this.http.getJson<RawOrderGrid>("/customer/account/orders", {
      "pagination[page]": page,
      "pagination[per_page]": perPage,
      "sort[column]": "created_at",
      "sort[order]": "desc",
    });
    return mapOrderGrid(raw);
  }

  async getOrder(orderId: number): Promise<OrderDetails> {
    const html = await this.http.getHtml(`/customer/account/orders/view/${orderId}`);
    return parseOrderPage(orderId, html);
  }

  /** The site's own "repeat order": puts all items of a past order into the cart. */
  async reorder(orderId: number): Promise<Cart> {
    const res = await this.http.request("GET", `/customer/account/orders/reorder/${orderId}`, {
      accept: "html",
      redirect: "manual",
    });
    await res.arrayBuffer();
    return this.getCart();
  }

  // ---------- Mapping ----------

  private toProduct(r: RawProduct): Product {
    const attributes: Record<string, string> = {};
    for (const group of [r.placement_top_left, r.placement_top_right, r.placement_bottom_left, r.placement_bottom_right]) {
      for (const a of group ?? []) attributes[a.name] = a.value;
    }
    return {
      id: r.id,
      sku: r.sku,
      name: r.name,
      url: `${this.http.baseUrl}/${r.url_key}`,
      urlKey: r.url_key,
      price: r.prices.final.price,
      regularPrice: r.prices.regular.price,
      tierPrices: toTiers(r.extra_prices),
      inStock: r.qty,
      saleable: r.is_saleable,
      madeToOrder: r.made_to_order,
      onSale: r.on_sale,
      isNew: r.is_new,
      finalSale: r.is_final_sale,
      image: r.base_image?.medium_image_url,
      attributes,
    };
  }

  private toCart(c: RawCart | null): Cart {
    if (!c) {
      return {
        cartId: null,
        isGuest: null,
        itemsCount: 0,
        itemsQty: 0,
        subTotal: 0,
        discount: 0,
        couponCode: null,
        shipping: 0,
        grandTotal: 0,
        currency: "UAH",
        items: [],
      };
    }
    return {
      cartId: c.id,
      isGuest: Boolean(c.is_guest),
      itemsCount: c.items_count,
      itemsQty: c.items_qty,
      subTotal: c.sub_total,
      discount: c.discount_amount,
      couponCode: c.coupon_code,
      shipping: c.shipping_amount,
      grandTotal: c.grand_total,
      currency: "UAH",
      freeDeliveryThreshold: c.delivery_cost?.threshold,
      remainingForFreeDelivery: c.delivery_cost?.remaining_amount,
      items: c.items.map((i) => ({
        itemId: i.id,
        name: i.name,
        urlKey: i.product_url_key,
        quantity: i.quantity,
        unitPrice: Number(i.price),
        total: Number(i.total),
        maxQty: i.maxValue,
        tierPrices: toTiers(i.extra_prices),
      })),
    };
  }
}

function toTiers(extra?: RawTierPrice[]): TierPrice[] {
  return (extra ?? []).map((t) => ({ minQty: t.qty, price: t.price }));
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
