/** Raw shapes returned by yumi.market's internal shop API (only the fields we use). */

export interface RawMoney {
  price: number;
  formatted_price: string;
}

export interface RawTierPrice extends RawMoney {
  qty: number;
  label: string;
}

export interface RawPlacement {
  name: string;
  value: string;
}

export interface RawProduct {
  id: number;
  sku: string;
  name: string;
  url_key: string;
  type: string;
  qty: number;
  is_saleable: boolean;
  made_to_order: boolean;
  on_sale: boolean;
  is_new: boolean;
  is_final_sale: boolean;
  min_price: string;
  prices: { final: RawMoney; regular: RawMoney };
  extra_prices?: RawTierPrice[];
  base_image?: { medium_image_url?: string };
  placement_top_left?: RawPlacement[] | null;
  placement_top_right?: RawPlacement[] | null;
  placement_bottom_left?: RawPlacement[] | null;
  placement_bottom_right?: RawPlacement[] | null;
}

export interface RawPagination {
  current_page: number;
  last_page: number;
  per_page: number;
  total: number;
}

export interface RawProductList {
  data: RawProduct[];
  meta: { pagination: RawPagination };
}

export interface RawCategory {
  id: number;
  parent_id: number | null;
  name: string;
  slug: string;
  status: boolean;
}

export interface RawCategoryTreeNode {
  id: number;
  name: string;
  url: string;
  children: RawCategoryTreeNode[];
}

export interface RawFilterAttribute {
  id: number;
  code: string;
  type: string;
  name: string;
}

export interface RawCartItem {
  id: number;
  quantity: number;
  name: string;
  price: string;
  formatted_price: string;
  total: string;
  formatted_total: string;
  product_url_key: string;
  maxValue: number;
  extra_prices?: RawTierPrice[];
  made_to_order: boolean;
}

export interface RawCart {
  id: number;
  is_guest: number;
  items_count: number;
  items_qty: number;
  sub_total: number;
  formatted_sub_total: string;
  discount_amount: number;
  formatted_discount_amount: string;
  coupon_code: string | null;
  shipping_amount: number;
  grand_total: number;
  formatted_grand_total: string;
  items: RawCartItem[];
  delivery_cost?: {
    threshold?: number;
    remaining_amount?: number;
    nova_poshta_free_delivery_qualified?: boolean;
  };
}

export interface RawCartResponse {
  data: RawCart | null;
  message?: string;
}

/** Normalized shapes exposed by YumiClient. */

export interface TierPrice {
  minQty: number;
  price: number;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  url: string;
  urlKey: string;
  price: number;
  regularPrice: number;
  tierPrices: TierPrice[];
  inStock: number;
  saleable: boolean;
  madeToOrder: boolean;
  onSale: boolean;
  isNew: boolean;
  finalSale: boolean;
  image?: string;
  attributes: Record<string, string>;
}

export interface ProductPage {
  items: Product[];
  page: number;
  lastPage: number;
  perPage: number;
  total: number;
  note?: string;
}

export interface ProductDetails {
  id: number | null;
  urlKey: string;
  url: string;
  name: string;
  sku?: string;
  description?: string;
  image?: string;
  /** Live listing data (price tiers, stock), found by SKU. */
  listing?: Product;
}

export interface CartItem {
  itemId: number;
  name: string;
  urlKey: string;
  quantity: number;
  unitPrice: number;
  total: number;
  maxQty: number;
  tierPrices: TierPrice[];
}

export interface Cart {
  cartId: number | null;
  /** null when the cart is empty (the site does not say whose it is). */
  isGuest: boolean | null;
  itemsCount: number;
  itemsQty: number;
  subTotal: number;
  discount: number;
  couponCode: string | null;
  shipping: number;
  grandTotal: number;
  currency: "UAH";
  freeDeliveryThreshold?: number;
  remainingForFreeDelivery?: number;
  items: CartItem[];
}

/**
 * Sorts supported by the site ("name-asc" = site default "За порядком", "created_at-desc" = newest first)
 * plus price sorts, which YumiClient does itself because the site has none.
 */
export type ProductSort =
  | "name-asc"
  | "created_at-desc"
  | "final_sale-desc"
  | "exclusive-desc"
  | "price-asc"
  | "price-desc";

export interface SearchParams {
  query?: string;
  categoryId?: number;
  /** Attribute filters, e.g. { cvet: [577], razmer_v_diuimax: [123] } (option ids). */
  filters?: Record<string, Array<number | string>>;
  /** Price range in UAH. */
  minPrice?: number;
  maxPrice?: number;
  sort?: ProductSort;
  page?: number;
  limit?: number;
}
