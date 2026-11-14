import { parse, type HTMLElement } from "node-html-parser";

/**
 * Parse a storefront page. Bagisto renders many blocks (tabs, forms) inside
 * <script type="text/x-template"> for Vue, so those are parsed too.
 */
export function parseRoots(html: string): HTMLElement[] {
  const root = parse(html);
  const roots = [root];
  for (const s of root.querySelectorAll('script[type="text/x-template"]')) {
    roots.push(parse(s.rawText.replace(/<template\b[^>]*>/g, "<div>").replace(/<\/template>/g, "</div>")));
  }
  return roots;
}

export function text(el: HTMLElement | null | undefined): string {
  return (el?.text ?? "").replace(/\s+/g, " ").trim();
}

/** Value element that follows a label element (e.g. <p>Спосіб оплати</p><p>Картою</p>). */
export function labelValue(roots: HTMLElement[], label: string): string | undefined {
  for (const root of roots) {
    for (const el of root.querySelectorAll("p, span, div, label")) {
      if (el.childNodes.length > 1 && el.querySelector("*")) continue;
      if (text(el) !== label) continue;
      const value = text(el.nextElementSibling);
      if (value) return value;
    }
  }
  return undefined;
}

/** "1 234.42₴" -> 1234.42; non-numeric text -> null. */
export function money(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.replace(/\s/g, "").match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(",", ".")) : null;
}

export interface FormSpec {
  action: string;
  fields: Array<{ name: string; type: string; value: string }>;
}

/** Find a (v-)form by action and list its named fields. */
export function findForm(roots: HTMLElement[], actionMatch: (action: string) => boolean): FormSpec | undefined {
  for (const root of roots) {
    for (const f of root.querySelectorAll("form, v-form")) {
      const action = f.getAttribute("action") ?? "";
      if (!actionMatch(action)) continue;
      // Vue renders one field as <v-field name> + <input name> + <v-error-message name>: keep one per name.
      const byName = new Map<string, FormSpec["fields"][number]>();
      for (const el of f.querySelectorAll("[name]")) {
        const tag = el.tagName.toLowerCase();
        if (tag === "v-error-message") continue;
        const name = el.getAttribute("name")!;
        const field = {
          name,
          type: (el.getAttribute("type") ?? tag).toLowerCase(),
          value: el.getAttribute("value") ?? "",
        };
        if (!byName.has(name) || tag === "input") byName.set(name, field);
      }
      return { action, fields: [...byName.values()] };
    }
  }
  return undefined;
}
