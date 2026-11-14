import { readFile, writeFile } from "node:fs/promises";

export class YumiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "YumiHttpError";
  }
}

export interface YumiHttpOptions {
  baseUrl?: string;
  /** Path to a JSON file where session cookies are persisted between runs. */
  sessionFile?: string;
  /** Raw cookie string ("a=1; b=2") to seed the jar, e.g. copied from the browser. */
  initialCookies?: string;
  /** Minimum delay between requests, to stay polite to the site. */
  minIntervalMs?: number;
  userAgent?: string;
}

type Query = Record<string, string | number | boolean | undefined | null>;

/**
 * Low-level HTTP layer for yumi.market (Bagisto / Laravel):
 * keeps a cookie jar (session + XSRF-TOKEN), sends the X-XSRF-TOKEN header on
 * mutating requests and throttles requests.
 */
export class YumiHttp {
  readonly baseUrl: string;
  private readonly cookies = new Map<string, string>();
  private readonly sessionFile?: string;
  private readonly minIntervalMs: number;
  private readonly userAgent: string;
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(opts: YumiHttpOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://yumi.market").replace(/\/+$/, "");
    this.sessionFile = opts.sessionFile;
    this.minIntervalMs = opts.minIntervalMs ?? 300;
    this.userAgent =
      opts.userAgent ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 yumi-api/0.1";
    if (opts.initialCookies) this.setCookieString(opts.initialCookies);
  }

  /** Replace or add cookies from a "name=value; name2=value2" string. */
  setCookieString(raw: string) {
    for (const part of raw.split(";")) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      this.cookies.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  }

  getCookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  async clearSession() {
    this.cookies.clear();
    await this.save();
  }

  async getJson<T>(path: string, query?: Query): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "json" });
    return (await res.json()) as T;
  }

  async sendJson<T>(method: "POST" | "PUT" | "DELETE", path: string, body: unknown): Promise<T> {
    const res = await this.request(method, path, { json: body, accept: "json" });
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async getHtml(path: string, query?: Query): Promise<string> {
    const res = await this.request("GET", path, { query, accept: "html" });
    return res.text();
  }

  async postForm(path: string, form: Record<string, string>, accept: "json" | "html" = "json"): Promise<Response> {
    return this.request("POST", path, { form, accept, redirect: "manual" });
  }

  /** Make sure we have an XSRF-TOKEN cookie (needed for any POST/PUT/DELETE). */
  async ensureXsrf() {
    await this.load();
    if (!this.cookies.has("XSRF-TOKEN")) {
      await this.request("GET", "/api/checkout/cart", { accept: "json" });
    }
  }

  async request(
    method: string,
    path: string,
    opts: {
      query?: Query;
      json?: unknown;
      form?: Record<string, string>;
      accept: "json" | "html";
      redirect?: RequestRedirect;
    },
  ): Promise<Response> {
    await this.load();
    if (method !== "GET") await this.ensureXsrfInner();

    const url = new URL(path.startsWith("http") ? path : this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      "Accept-Language": "uk-UA,uk;q=0.9",
      Referer: this.baseUrl + "/",
    };
    if (opts.accept === "json") {
      headers.Accept = "application/json";
      headers["X-Requested-With"] = "XMLHttpRequest";
    } else {
      headers.Accept = "text/html,application/xhtml+xml";
    }
    const xsrf = this.cookies.get("XSRF-TOKEN");
    if (method !== "GET" && xsrf) {
      headers["X-XSRF-TOKEN"] = decodeURIComponent(xsrf);
      headers.Origin = this.baseUrl;
    }

    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    }

    const res = await this.throttled(() => {
      const cookie = this.cookieHeader();
      return fetch(url, {
        method,
        headers: cookie ? { ...headers, Cookie: cookie } : headers,
        body,
        redirect: opts.redirect ?? "follow",
      });
    });

    this.storeSetCookies(res.headers);
    await this.save();

    if (res.status >= 400) {
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      const msg =
        (parsed as { message?: string })?.message ??
        (parsed as { error?: string })?.error ??
        `HTTP ${res.status}`;
      throw new YumiHttpError(`${method} ${url.pathname} failed: ${msg}`, res.status, parsed);
    }
    return res;
  }

  private async ensureXsrfInner() {
    if (this.cookies.has("XSRF-TOKEN")) return;
    const res = await this.throttled(() =>
      fetch(this.baseUrl + "/api/checkout/cart", {
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
        },
      }),
    );
    this.storeSetCookies(res.headers);
    await res.arrayBuffer();
  }

  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        this.lastRequestAt = Date.now();
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private storeSetCookies(headers: Headers) {
    const h = headers as Headers & { getSetCookie?: () => string[] };
    const list =
      typeof h.getSetCookie === "function"
        ? h.getSetCookie()
        : (headers.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z0-9_\-]+=)/);
    for (const raw of list) {
      const first = raw.split(";")[0];
      const idx = first.indexOf("=");
      if (idx <= 0) continue;
      const name = first.slice(0, idx).trim();
      const value = first.slice(idx + 1).trim();
      const expired = /max-age=0\b/i.test(raw) || value === "deleted" || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.sessionFile) return;
    try {
      const data = JSON.parse(await readFile(this.sessionFile, "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(data)) {
        if (!this.cookies.has(k)) this.cookies.set(k, v);
      }
    } catch {
      /* no saved session yet */
    }
  }

  private async save() {
    if (!this.sessionFile) return;
    await writeFile(this.sessionFile, JSON.stringify(Object.fromEntries(this.cookies), null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
