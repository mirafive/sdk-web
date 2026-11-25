import type { ConsentAdapter, ConsentStatus, Host } from "../consent/types";
import { createMira, type Mira, type MiraOptions } from "../mira";
import { KEYS } from "../storage";
import { VISITOR_COOKIE } from "./storefront";

/**
 * Pixel mode: MIRA inside a Shopify custom pixel (Settings → Customer events, permission "Not
 * required"). The pixel runs in a sandbox, an iframe on another origin, where `location` and
 * `document.referrer` describe the sandbox and not the shop. So this mode runs the same SDK on a
 * host that is the sandbox's window with four differences:
 *
 * - the page (URL, referrer, title) comes from each event's `context.document`;
 * - the visitor id lives in the storefront's cookie, read and written through `browser.cookie`
 *   (Shopify's API is asynchronous, the SDK's storage is not: a small in-memory store bridges
 *   them, filled before the SDK needs it);
 * - consent comes from `init.customerPrivacy` and `visitorConsentCollected`, never from a CMP
 *   scan;
 * - nothing is captured on its own: Shopify's standard events are mapped to MIRA's.
 *
 * It never sends money: `checkout_completed` carries the order id, total and currency as plain
 * properties. Revenue comes from the shop's server (docs/data-model.md, Which origins can create
 * money).
 */

interface Money {
  amount?: number;
  currencyCode?: string;
}
interface Variant {
  id?: string;
  sku?: string | null;
  title?: string;
  price?: Money;
  product?: { id?: string; title?: string };
}
interface Checkout {
  currencyCode?: string;
  totalPrice?: Money;
  lineItems?: { quantity?: number }[];
  order?: { id?: string };
}
export interface PixelDocument {
  location?: { href?: string };
  referrer?: string;
  title?: string;
}
export interface ShopifyEvent {
  name?: string;
  /** When the event happened (ISO 8601), by the visitor's clock: the pixel runs in their browser. */
  timestamp?: string;
  context?: { document?: PixelDocument };
  data?: {
    productVariant?: Variant;
    cartLine?: { quantity?: number; merchandise?: Variant; cost?: { totalAmount?: Money } };
    checkout?: Checkout;
  };
  customerPrivacy?: PixelPrivacy;
}
export interface PixelPrivacy {
  analyticsProcessingAllowed?: boolean;
  marketingAllowed?: boolean;
}

/** The three objects Shopify hands every custom pixel as globals, plus MIRA's settings. */
export interface ShopifyPixelInput {
  /**
   * Shopify's event bus. The pasted snippet subscribes itself (Shopify's pixel editor looks for
   * that call in the code) and hands each event over with `mira("shopifyEvent", event)`, so this
   * is left out there; the script then supplies its own.
   */
  analytics?: { subscribe(name: string, handler: (event: ShopifyEvent) => void): unknown };
  init: {
    context?: { document?: PixelDocument };
    customerPrivacy?: PixelPrivacy;
    data?: { customer?: { id?: string | null } | null };
  };
  /** Shopify's consent API for pixels: `subscribe` hears every decision after the first. */
  customerPrivacy?: {
    subscribe(name: string, handler: (event: ShopifyEvent) => void): unknown;
  };
  browser: {
    cookie: {
      get(name: string): Promise<string | undefined | null>;
      set(cookie: string): Promise<unknown>;
    };
  };
  /** The project's public key. */
  key: string;
  host?: string;
  debug?: boolean;
  /**
   * Which `page_viewed` events become pageviews. The default is `"checkout"`: on the storefront the
   * theme's script tag already sends the pageview, and a second one would count every visit twice.
   * `"all"` is for a shop without the script tag.
   */
  pages?: "checkout" | "all";
}

/** The events that become MIRA events, by their Shopify names, which the funnel templates know. */
const STEPS = new Set(["checkout_started", "payment_info_submitted", "checkout_completed"]);
const YEAR_S = 365 * 24 * 60 * 60;
/**
 * How far Shopify's event time may be from the clock here and still be believed. Real gaps are
 * seconds: the pixel hears an event as it happens.
 */
const SANE_MS = 60 * 60 * 1000;

/**
 * The time Shopify gave an event, when it is an ISO time within an hour of now. Shopify's docs
 * (web pixels API, standard events) call it "the timestamp of when the customer event occurred, in
 * ISO 8601 format" and do not say whose clock it is. The pixel runs in the visitor's browser, so
 * it is the visitor's clock like the SDK's own times: the transport's `sent_at` lets the server
 * correct either one, and the server bounds a claimed time again. Events are sent when the
 * sandbox hears them, which is not always in the order they happened: `payment_info_submitted`
 * can arrive after `checkout_completed`.
 */
export function eventTime(timestamp: unknown, now = Date.now()): Date | undefined {
  if (typeof timestamp !== "string") return undefined;
  const time = Date.parse(timestamp);
  return Number.isFinite(time) && Math.abs(time - now) <= SANE_MS ? new Date(time) : undefined;
}

const clean = (properties: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));

/** `gid://shopify/Product/123` → `123`: the id the admin and the webhooks use. */
const plain = (id: string | undefined | null) => (id ? id.split("/").pop() : undefined);

function checkoutProperties(checkout: Checkout | undefined) {
  if (!checkout) return {};
  return clean({
    total: checkout.totalPrice?.amount,
    currency: checkout.totalPrice?.currencyCode ?? checkout.currencyCode,
    item_count: checkout.lineItems?.reduce((sum, line) => sum + (line.quantity ?? 1), 0),
  });
}

const variantProperties = (variant: Variant | undefined) =>
  clean({
    product_id: plain(variant?.product?.id),
    variant_id: plain(variant?.id),
    product_title: variant?.product?.title,
    sku: variant?.sku ?? undefined,
    price: variant?.price?.amount,
    currency: variant?.price?.currencyCode,
  });

/** Shopify's event as the MIRA call that reports it, or nothing for events MIRA does not use. */
export function mapEvent(event: ShopifyEvent): { name: string; properties: object } | undefined {
  const name = event.name;
  if (!name) return undefined;
  if (name === "product_viewed") {
    return { name, properties: variantProperties(event.data?.productVariant) };
  }
  if (name === "product_added_to_cart") {
    const line = event.data?.cartLine;
    return {
      name,
      properties: clean({
        ...variantProperties(line?.merchandise),
        quantity: line?.quantity,
        total: line?.cost?.totalAmount?.amount,
      }),
    };
  }
  if (STEPS.has(name)) {
    const checkout = event.data?.checkout;
    return {
      name,
      properties:
        name === "checkout_completed"
          ? clean({ order_id: plain(checkout?.order?.id), ...checkoutProperties(checkout) })
          : checkoutProperties(checkout),
    };
  }
  return undefined;
}

const isCheckout = (href: string | undefined) => {
  try {
    return /^\/checkouts?(\/|$)/.test(new URL(href ?? "").pathname);
  } catch {
    return false;
  }
};

/**
 * The one key the pixel keeps in the storefront's cookies: the visitor. The signed-in customer is
 * not kept: a cookie that restored a customer on the next checkout would attribute a guest on a
 * shared device to the person before them, so the customer is named by each page's own data.
 */
const MIRRORED: Record<string, string> = {
  [KEYS.anonymousId]: VISITOR_COOKIE,
};

/**
 * In-memory `Storage` for the SDK, mirrored to the storefront's cookie for the visitor id.
 */
function bridgedStorage(
  cookie: ShopifyPixelInput["browser"]["cookie"],
  warn: (message: string, error?: unknown) => void,
) {
  const data = new Map<string, string>();
  /** Bumped by `forget`: a read that began before it is dropped, so a withdrawn id never returns. */
  let generation = 0;
  const write = (name: string, value: string | undefined) =>
    void Promise.resolve(
      cookie.set(
        value
          ? `${name}=${value}; Max-Age=${YEAR_S}; Path=/; SameSite=Lax; Secure`
          : `${name}=; Max-Age=0; Path=/; SameSite=Lax`,
      ),
    ).catch((error) =>
      warn("the visitor's id could not be written to the storefront cookie", error),
    );
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem(key: string, value: string) {
      const changed = data.get(key) !== value;
      data.set(key, value);
      const name = MIRRORED[key];
      if (name && changed) write(name, value);
    },
    removeItem(key: string) {
      const had = data.delete(key);
      const name = MIRRORED[key];
      if (name && had) write(name, undefined);
    },
  } as unknown as Storage;
  /** Reads the storefront's ids into the store; only called once analytics is allowed. */
  const load = async () => {
    const started = generation;
    for (const [key, name] of Object.entries(MIRRORED)) {
      try {
        const value = await cookie.get(name);
        if (started !== generation) return;
        if (value && !data.has(key)) data.set(key, value);
      } catch (error) {
        // No cookie access: a new visitor id; the order's attribute still joins a guest's order.
        warn("the storefront's visitor id could not be read", error);
      }
    }
  };
  /** Not consented: what an earlier visit left in the cookies goes. Deleting needs no read. */
  const forget = () => {
    generation += 1;
    data.clear();
    for (const name of Object.values(MIRRORED)) write(name, undefined);
  };
  return { storage, load, forget };
}

const bound = (target: object, value: unknown) =>
  typeof value === "function" ? value.bind(target) : value;

/** `window` with the sandbox's own page, viewport and storage replaced. */
function pixelHost(
  window: Host,
  page: () => { href: string; referrer: string; title: string },
  storage: Storage,
) {
  const document = new Proxy(window.document, {
    get(target, property) {
      const current = page();
      if (property === "referrer") return current.referrer;
      if (property === "title") return current.title;
      return bound(target, Reflect.get(target, property, target));
    },
  });
  return new Proxy(window, {
    get(target, property) {
      switch (property) {
        case "location":
          return { href: page().href };
        case "document":
          return document;
        case "localStorage":
        case "sessionStorage":
          return storage;
        // The iframe's size is not the shop's window.
        case "innerWidth":
        case "innerHeight":
          return undefined;
        default:
          return bound(target, Reflect.get(target, property, target));
      }
    },
  });
}

const fromPrivacy = (privacy: PixelPrivacy | undefined): ConsentStatus => ({
  analytics: privacy?.analyticsProcessingAllowed ? "granted" : "denied",
  marketing: privacy?.marketingAllowed ? "granted" : "denied",
});

/**
 * Starts MIRA in a custom pixel. Resolves to the SDK instance, or `undefined` when the input is not
 * what Shopify hands a pixel (a setup error, so it is logged). Never throws into the pixel.
 */
export async function startShopifyPixel(
  window: Host,
  input: ShopifyPixelInput,
): Promise<Mira | undefined> {
  const debug = input?.debug === true;
  const warn = (message: string, error?: unknown) => {
    if (debug) console.warn(`MIRA FIVE: ${message}`, error ?? "");
  };
  try {
    const { analytics, init, browser } = input ?? {};
    if (!analytics?.subscribe || !browser?.cookie || !input.key) {
      console.warn(
        "MIRA FIVE: the pixel needs `init`, `browser` and the project's public key: mira('shopifyPixel', { init, browser, customerPrivacy, key }), and its events through analytics.subscribe. Nothing is sent.",
      );
      return undefined;
    }

    let current = { href: "", referrer: "", title: "" };
    const note = (document: PixelDocument | undefined) => {
      if (!document?.location?.href) return;
      current = {
        href: document.location.href,
        referrer: document.referrer ?? "",
        title: document.title ?? "",
      };
    };
    note(init?.context?.document);

    const bridge = bridgedStorage(browser.cookie, warn);
    const host = pixelHost(window, () => current, bridge.storage);

    // Consent: the state at load, then every decision. The visitor's id is read before MIRA hears
    // "granted", so a returning visitor keeps theirs.
    let latest = fromPrivacy(init?.customerPrivacy);
    let emit: ((status: ConsentStatus) => void) | undefined;
    const adapter: ConsentAdapter = {
      name: "shopify-pixel",
      detect: () => true,
      subscribe(_host, send) {
        emit = send;
        send(latest);
        return () => {
          emit = undefined;
        };
      },
    };
    const ready = (async () => {
      if (latest.analytics === "granted") await bridge.load();
      else bridge.forget();
    })();
    if (input.customerPrivacy?.subscribe) {
      input.customerPrivacy.subscribe("visitorConsentCollected", (event) => {
        void ready.then(async () => {
          latest = fromPrivacy(event?.customerPrivacy);
          // A "no" that arrives while the cookie of an earlier "yes" is still being read removes
          // it as well: what the read finds is never put to use.
          if (latest.analytics !== "granted") bridge.forget();
          else await bridge.load();
          emit?.(latest);
        });
      });
    } else {
      console.warn(
        "MIRA FIVE: pass `customerPrivacy` to the pixel (mira('shopifyPixel', { …, customerPrivacy })), or a visitor's later consent decision is not heard.",
      );
    }

    // Events that arrive while the visitor's id is read wait for the SDK.
    let mira: Mira | undefined;
    const waiting: ShopifyEvent[] = [];
    // The ingest needs a page URL on every event (Origin: null is accepted only with one), so an
    // event waits for a page that names its URL, and so does the identify.
    let identified = false;
    // The time of the event being reported: set around the synchronous call that queues it.
    let eventAt: Date | undefined;
    const report = (event: ShopifyEvent) => {
      try {
        note(event.context?.document);
        if (!current.href || !mira) return;
        const customer = plain(init?.data?.customer?.id);
        if (customer && !identified) {
          identified = true;
          // Namespaced like the theme snippet: a bare id could collide with the shop's own user ids.
          mira.identify(`shopify:${customer}`, {}, { externalIds: { shopify_customer: customer } });
        }
        eventAt = eventTime(event.timestamp);
        if (event.name === "page_viewed") {
          if (input.pages === "all" || isCheckout(current.href)) mira.page();
          return;
        }
        const mapped = mapEvent(event);
        if (mapped) mira.track(mapped.name, mapped.properties as Record<string, unknown>);
      } catch (error) {
        warn("an event could not be reported", error);
      } finally {
        eventAt = undefined;
      }
    };
    analytics.subscribe("all_standard_events", (event) => {
      if (mira) report(event);
      else waiting.push(event);
    });
    await ready;

    const options: MiraOptions = {
      key: input.key,
      host: input.host,
      consent: "auto",
      adapters: [adapter],
      autocapture: false,
      debug,
    };
    mira = createMira(options, host, () => eventAt ?? new Date());
    // Events that only the start's own document describes (no event yet) are reported at once.
    report({});

    // The page the pixel started on may already name its URL.
    for (const event of waiting.splice(0)) report(event);
    return mira;
  } catch (error) {
    warn("the pixel could not start", error);
    return undefined;
  }
}
