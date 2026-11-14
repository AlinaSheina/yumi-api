import { Router, type NextFunction, type Request, type Response } from "express";
import { YumiHttpError, type ProductSort, type YumiClient } from "../yumi/index.js";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res)
      .then((data) => res.json(data))
      .catch((err) => {
        if (err instanceof YumiHttpError) {
          res.status(err.status >= 500 ? 502 : err.status).json({ error: err.message, upstream: err.body });
        } else next(err);
      });
  };

const num = (v: unknown) => (v === undefined || v === "" ? undefined : Number(v));

function intParam(req: Request, name: string): number {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n)) throw Object.assign(new Error(`Invalid ${name}`), { status: 400 });
  return n;
}

export function yumiRouter(yumi: YumiClient) {
  const r = Router();

  // ----- Catalog -----

  // GET /catalog/products?query=gemar&categoryId=769&sort=price-asc&page=1&limit=24&minPrice=5&maxPrice=20&f.cvet=577,584
  r.get(
    "/catalog/products",
    wrap(async (req) => {
      const q = req.query as Record<string, string | undefined>;
      const filters: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(q)) {
        if (k.startsWith("f.") && v) filters[k.slice(2)] = v.split(",");
      }
      return yumi.searchProducts({
        query: q.query,
        categoryId: num(q.categoryId),
        sort: q.sort as ProductSort | undefined,
        page: num(q.page),
        limit: num(q.limit),
        minPrice: num(q.minPrice),
        maxPrice: num(q.maxPrice),
        filters,
      });
    }),
  );

  r.get(
    "/catalog/products/sku/:sku",
    wrap(async (req, res) => {
      const p = await yumi.findBySku(String(req.params.sku));
      if (!p) res.status(404);
      return p ?? { error: "Not Found" };
    }),
  );

  r.get("/catalog/products/:urlKey", wrap((req) => yumi.getProduct(String(req.params.urlKey))));
  r.get("/catalog/categories", wrap(() => yumi.getCategoryTree()));
  r.get("/catalog/categories/:id/filters", wrap((req) => yumi.getCategoryFilters(intParam(req, "id"))));
  r.get(
    "/catalog/filters/:attributeId/options",
    wrap((req) => yumi.getFilterOptions(intParam(req, "attributeId"), num(req.query.categoryId))),
  );
  r.get("/catalog/suggestions", wrap((req) => yumi.searchSuggestions(String(req.query.q ?? ""))));

  // ----- Cart -----

  r.get("/cart", wrap(() => yumi.getCart()));

  // POST /cart/items { productId, quantity }
  r.post(
    "/cart/items",
    wrap(async (req) => {
      const { productId, quantity } = req.body ?? {};
      if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 1) {
        throw Object.assign(new Error("productId and quantity (positive integers) are required"), { status: 400 });
      }
      return yumi.addToCart(productId, quantity);
    }),
  );

  // PATCH /cart/items/:itemId { quantity }
  r.patch(
    "/cart/items/:itemId",
    wrap(async (req) => {
      const quantity = req.body?.quantity;
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw Object.assign(new Error("quantity (positive integer) is required"), { status: 400 });
      }
      return yumi.updateCartQuantities({ [intParam(req, "itemId")]: quantity });
    }),
  );

  r.delete("/cart/items/:itemId", wrap((req) => yumi.removeCartItem(intParam(req, "itemId"))));
  r.post("/cart/items/:itemId/move-to-wishlist", wrap((req) => yumi.moveCartItemToWishlist(intParam(req, "itemId"))));

  // ----- Wishlist -----

  r.get("/wishlist", wrap(() => yumi.getWishlist()));

  // POST /wishlist { productId }
  r.post(
    "/wishlist",
    wrap(async (req) => {
      const productId = req.body?.productId;
      if (!Number.isInteger(productId)) {
        throw Object.assign(new Error("productId (integer) is required"), { status: 400 });
      }
      return yumi.addToWishlist(productId);
    }),
  );

  r.delete("/wishlist/:wishlistId", wrap((req) => yumi.removeFromWishlist(intParam(req, "wishlistId"))));

  // POST /wishlist/:wishlistId/move-to-cart { quantity? }
  r.post(
    "/wishlist/:wishlistId/move-to-cart",
    wrap(async (req) => {
      const quantity = req.body?.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw Object.assign(new Error("quantity must be a positive integer"), { status: 400 });
      }
      return yumi.moveWishlistItemToCart(intParam(req, "wishlistId"), quantity);
    }),
  );

  // ----- Account -----

  r.get("/auth/status", wrap(async () => ({ loggedIn: await yumi.isLoggedIn() })));

  // POST /auth/login/send { email } -> the site e-mails a one-time code
  r.post(
    "/auth/login/send",
    wrap(async (req) => {
      const email = req.body?.email;
      if (typeof email !== "string" || !email.includes("@")) {
        throw Object.assign(new Error("email is required"), { status: 400 });
      }
      return yumi.sendLoginCode(email);
    }),
  );

  // POST /auth/login/verify { code }
  r.post(
    "/auth/login/verify",
    wrap(async (req) => {
      const code = req.body?.code;
      if (typeof code !== "string" || !code.trim()) {
        throw Object.assign(new Error("code is required"), { status: 400 });
      }
      return yumi.verifyLoginCode(code);
    }),
  );

  r.post("/auth/logout", wrap(async () => (await yumi.logout(), { loggedIn: false })));

  // ----- Orders -----

  r.get("/orders", wrap((req) => yumi.listOrders(num(req.query.page), num(req.query.perPage))));
  r.get("/orders/:id", wrap((req) => yumi.getOrder(intParam(req, "id"))));
  r.post("/orders/:id/reorder", wrap((req) => yumi.reorder(intParam(req, "id"))));

  return r;
}
