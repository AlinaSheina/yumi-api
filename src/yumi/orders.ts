import { labelValue, money, parseRoots, text } from "./html.js";

export interface OrderSummary {
  id: number;
  number: string;
  createdAt: string;
  status: string;
  statusCode?: string;
  grandTotal: number | null;
  currency: string;
}

export interface OrderPage {
  items: OrderSummary[];
  page: number;
  lastPage: number;
  perPage: number;
  total: number;
}

export interface OrderLine {
  sku: string;
  name: string;
  price: number | null;
  quantity: number;
  total: number | null;
}

export interface OrderDetails {
  id: number;
  number?: string;
  date?: string;
  status?: string;
  items: OrderLine[];
  subTotal: number | null;
  shipping: string | null;
  tax: number | null;
  grandTotal: number | null;
  shippingMethod?: string;
  paymentMethod?: string;
  shippingAddress?: string;
}

export interface RawOrderGrid {
  records: Array<{
    id: number;
    increment_id: string;
    status: string;
    created_at: string;
    grand_total: string;
    order_currency_code: string;
  }>;
  meta: { current_page: number; last_page: number; per_page: number; total: number };
}

export function mapOrderGrid(raw: RawOrderGrid): OrderPage {
  return {
    items: raw.records.map((r) => ({
      id: r.id,
      number: r.increment_id,
      createdAt: r.created_at,
      status: r.status.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      statusCode: r.status.match(/label-([a-z_]+)/)?.[1],
      grandTotal: money(r.grand_total),
      currency: r.order_currency_code,
    })),
    page: raw.meta.current_page,
    lastPage: raw.meta.last_page,
    perPage: raw.meta.per_page,
    total: raw.meta.total,
  };
}

/** Parse /customer/account/orders/view/{id}. */
export function parseOrderPage(id: number, html: string): OrderDetails {
  const roots = parseRoots(html);
  const title = text(roots[0].querySelector("title"));

  // Header of the "Інформація" tab: <span>date</span> <span/> <span>status</span>
  let date: string | undefined;
  let status: string | undefined;
  for (const root of roots) {
    const tab = root.querySelector("v-tab-item");
    if (!tab) continue;
    const spans = tab.querySelectorAll("span").map(text).filter(Boolean);
    date = spans.find((s) => /\d{4}/.test(s));
    status = spans.find((s) => s !== date);
    break;
  }

  const items: OrderLine[] = [];
  for (const root of roots) {
    // Invoice-style table: Артикул | Назва | Ціна | Кількість | Підсумок
    const rows = root.querySelectorAll("tr").filter((tr) => tr.querySelector('td[data-value="Артикул"]'));
    if (rows.length) {
      for (const tr of rows) {
        const cell = (k: string) => text(tr.querySelector(`td[data-value="${k}"]`));
        items.push({
          sku: cell("Артикул"),
          name: cell("Назва"),
          price: money(cell("Ціна")),
          quantity: parseInt(cell("Кількість"), 10) || 0,
          total: money(cell("Підсумок")),
        });
      }
      break;
    }
    // Order-items table: Назва (image) | Назва (name + <p>sku</p><p>price</p>) | Кількість | Підсумок
    const itemRows = root
      .querySelectorAll("tr")
      .filter((tr) => tr.querySelectorAll('td[data-value="Назва"]').length >= 1 && tr.querySelector('td[data-value="Кількість"]'));
    if (itemRows.length) {
      for (const tr of itemRows) {
        const nameCell = tr.querySelectorAll('td[data-value="Назва"]').find((td) => td.querySelector("p"));
        if (!nameCell) continue;
        const ps = nameCell.querySelectorAll("p").map(text);
        const name = nameCell.childNodes
          .filter((n) => n.nodeType === 3)
          .map((n) => n.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        items.push({
          sku: ps[0] ?? "",
          name,
          price: money(ps[1]),
          quantity: parseInt(text(tr.querySelector('td[data-value="Кількість"]')), 10) || 0,
          total: money(text(tr.querySelector('td[data-value="Підсумок"]'))),
        });
      }
      break;
    }
  }

  return {
    id,
    number: title.match(/#\s*(\S+)/)?.[1],
    date,
    status,
    items,
    subTotal: money(labelValue(roots, "Підсумок")),
    shipping: labelValue(roots, "Доставка та обробка") ?? labelValue(roots, "Доставка:") ?? null,
    tax: money(labelValue(roots, "Податок")),
    grandTotal: money(labelValue(roots, "Загальна сума")),
    shippingMethod: labelValue(roots, "Спосіб доставки"),
    paymentMethod: labelValue(roots, "Спосіб оплати"),
    shippingAddress: labelValue(roots, "Адреса доставки"),
  };
}
