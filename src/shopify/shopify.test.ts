/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion, eslint/no-underscore-dangle, unicorn/consistent-function-scoping -- test fakes stand in for browser globals and cart attributes start with an underscore */
import { describe, expect, spyOn, test } from "bun:test";

import { validateEvent } from "@mirafive/protocol";

import { fromCustomerPrivacy, shopify } from "../consent/shopify";
import { createMira } from "../mira";
import { fakeHost, tick } from "../test/fake-host";
import {
  eventTime,
  mapEvent,
  startShopifyPixel,
  type ShopifyEvent,
  type ShopifyPixelInput,
} from "./pixel";
import { CART_ATTRIBUTE, shopifyStorefront } from "./storefront";

const KEY = "pk_test_123";
const HOST = "https://ingest.example";
const PAGE = {
  location: { href: "https://shop.example/products/shirt?utm_source=news&gclid=abc" },
  referrer: "https://www.google.com/",
  title: "Shirt",
};

/** A Shopify custom pixel's globals: events, consent and a cookie jar, all recorded. */
function fakePixel(
  options: {
    analytics?: boolean;
    marketing?: boolean;
    cookies?: Record<string, string>;
    customer?: string;
  } = {},
) {
  const handlers = new Map<string, ((event: ShopifyEvent) => void)[]>();
  const privacyHandlers: ((event: ShopifyEvent) => void)[] = [];
  const jar = new Map(Object.entries(options.cookies ?? {}));
  const reads: string[] = [];
  const writes: string[] = [];
  const input: ShopifyPixelInput = {
    key: KEY,
    host: HOST,
    pages: "all",
    analytics: {
      subscribe(name, handler) {
        // Like Shopify: a name that is not a standard event is an error.
        if (name === "visitorConsentCollected") throw new Error(`unknown event ${name}`);
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    },
    customerPrivacy: {
      subscribe(name, handler) {
        // Like Shopify: this is the only event it publishes.
        if (name !== "visitorConsentCollected") throw new Error(`unknown event ${name}`);
        privacyHandlers.push(handler);
      },
    },
    init: {
      context: { document: PAGE },
      customerPrivacy: {
        analyticsProcessingAllowed: options.analytics ?? false,
        marketingAllowed: options.marketing ?? false,
      },
      data: { customer: options.customer ? { id: options.customer } : null },
    },
    browser: {
      cookie: {
        async get(name) {
          reads.push(name);
          return jar.get(name);
        },
        async set(cookie) {
          writes.push(cookie);
          const [pair] = cookie.split(";");
          const [name, value] = pair!.split("=");
          if (value) jar.set(name!, value);
          else jar.delete(name!);
        },
      },
    },
  };
  const emit = (event: ShopifyEvent) => {
    if (event.name === "visitorConsentCollected") {
      for (const handler of privacyHandlers) handler(event);
      return;
    }
    for (const handler of [
      ...(handlers.get(event.name ?? "") ?? []),
      ...(handlers.get("all_events") ?? []),
    ])
      handler(event);
  };
  return { input, emit, jar, reads, writes };
}

const variant = {
  id: "gid://shopify/ProductVariant/222",
  sku: "S-1",
  price: { amount: 29.9, currencyCode: "EUR" },
  product: { id: "gid://shopify/Product/111", title: "Shirt" },
};
const checkout = {
  totalPrice: { amount: 59.8, currencyCode: "EUR" },
  lineItems: [{ quantity: 2 }],
  order: { id: "gid://shopify/OrderIdentity/5512" },
};

describe("pixel mode", () => {
  test("consent declined: T0 only, nothing read from or written to the device", async () => {
    const fake = fakeHost({ url: "https://sandbox.invalid/", referrer: "" });
    const pixel = fakePixel();
    const mira = await startShopifyPixel(fake.host, pixel.input);
    expect(mira).toBeDefined();
    pixel.emit({ name: "page_viewed", context: { document: PAGE } });
    pixel.emit({
      name: "product_viewed",
      context: { document: PAGE },
      data: { productVariant: variant },
    });
    await mira!.flush();

    const events = fake.events();
    expect(events.map((event) => event.event)).toEqual(["$pageview", "product_viewed"]);
    for (const event of events) {
      expect(event.anonymous_id).toBeUndefined();
      expect(event.consent).toEqual({ analytics: "denied", marketing: "denied" });
      // The shop's page, not the sandbox's.
      expect(event.context.page.url).toBe(PAGE.location.href);
      expect(event.context.page.referrer).toBe("https://www.google.com/");
      expect(event.context.page.title).toBe("Shirt");
      expect(event.context.viewport).toBeUndefined();
      expect(validateEvent(event)).toEqual([]);
    }
    expect(pixel.reads).toEqual([]);
    // Nothing is read or stored; only what an earlier visit left is deleted.
    expect(pixel.writes.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
    expect(fake.storageReads()).toBe(0);
  });

  test("consent given: the storefront's visitor id is the pixel's", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ analytics: true, cookies: { mira_aid: "0192-storefront-id" } });
    const mira = await startShopifyPixel(fake.host, pixel.input);
    pixel.emit({ name: "page_viewed", context: { document: PAGE } });
    await mira!.flush();
    expect(fake.events()[0]!.anonymous_id).toBe("0192-storefront-id");
    expect(mira!.anonymousId).toBe("0192-storefront-id");
    expect(pixel.writes).toEqual([]);
  });

  test("a new visitor's id is written to the storefront cookie", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ analytics: true });
    const mira = await startShopifyPixel(fake.host, pixel.input);
    await tick();
    expect(mira!.anonymousId).toBeDefined();
    expect(pixel.jar.get("mira_aid")).toBe(mira!.anonymousId!);
    expect(pixel.writes[0]).toContain("Secure");
  });

  test("consent collected later upgrades; a cookie left by a withdrawn visit is gone", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ cookies: { mira_aid: "withdrawn-visit" } });
    const mira = await startShopifyPixel(fake.host, pixel.input);
    pixel.emit({ name: "page_viewed", context: { document: PAGE } });
    expect(pixel.reads).toEqual([]);
    expect(pixel.jar.has("mira_aid")).toBe(false);
    pixel.emit({
      name: "visitorConsentCollected",
      customerPrivacy: { analyticsProcessingAllowed: true, marketingAllowed: false },
    });
    await tick(5);
    expect(mira!.status).toEqual({ analytics: "granted", marketing: "denied" });
    expect(mira!.anonymousId).toBeDefined();
    expect(pixel.jar.get("mira_aid")).toBe(mira!.anonymousId!);
    await mira!.flush();
    expect(fake.events().map((event) => event.event)).toEqual(["$pageview", "$consent_changed"]);
  });

  test("a logged-in customer is identified with their Shopify id", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ analytics: true, customer: "8812" });
    const mira = await startShopifyPixel(fake.host, pixel.input);
    await mira!.flush();
    const identify = fake.events().find((event) => event.type === "identify")!;
    expect(identify.user_id).toBe("8812");
    expect(identify.external_ids).toEqual({ shopify_customer: "8812" });
  });

  test("checkout events carry the order as plain properties and never a revenue event", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ analytics: true });
    const mira = await startShopifyPixel(fake.host, pixel.input);
    const document = { ...PAGE, location: { href: "https://shop.example/checkouts/c1/thank-you" } };
    pixel.emit({ name: "checkout_completed", context: { document }, data: { checkout } });
    await mira!.flush();
    const [event] = fake.events();
    expect(event).toMatchObject({
      type: "track",
      event: "checkout_completed",
      properties: { order_id: "5512", total: 59.8, currency: "EUR", item_count: 2 },
    });
    expect(event!.context.page.url).toBe(document.location.href);
    expect(validateEvent(event!)).toEqual([]);
  });

  test("events that arrive while the visitor id is read are not lost", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ analytics: true });
    const started = startShopifyPixel(fake.host, pixel.input);
    pixel.emit({ name: "page_viewed", context: { document: PAGE } });
    const mira = await started;
    await mira!.flush();
    expect(fake.events().map((event) => event.event)).toEqual(["$pageview"]);
  });

  test("input that is not a pixel's does nothing and does not throw", async () => {
    const fake = fakeHost();
    expect(await startShopifyPixel(fake.host, {} as ShopifyPixelInput)).toBeUndefined();
  });
});

describe("pixel mode: more", () => {
  test("by default only checkout pages are pageviews; the theme's tag owns the storefront", async () => {
    const fake = fakeHost();
    const pixel = fakePixel();
    pixel.input.pages = undefined;
    const mira = await startShopifyPixel(fake.host, pixel.input);
    pixel.emit({ name: "page_viewed", context: { document: PAGE } });
    const checkoutPage = { ...PAGE, location: { href: "https://shop.example/checkouts/cn/abc" } };
    pixel.emit({ name: "page_viewed", context: { document: checkoutPage } });
    await mira!.flush();
    expect(fake.events().map((event) => event.context.page.url)).toEqual([
      checkoutPage.location.href,
    ]);
  });

  test("payment_info_submitted is the total and currency, nothing else", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ analytics: true });
    const mira = await startShopifyPixel(fake.host, pixel.input);
    pixel.emit({ name: "payment_info_submitted", context: { document: PAGE }, data: { checkout } });
    await mira!.flush();
    expect(fake.events()[0]).toMatchObject({
      event: "payment_info_submitted",
      properties: { total: 59.8, currency: "EUR", item_count: 2 },
    });
    expect(fake.events()[0]!.properties.order_id).toBeUndefined();
  });

  test("consent withdrawn: back to T0, the visitor id leaves the cookie", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ analytics: true, cookies: { mira_aid: "returning" } });
    const mira = await startShopifyPixel(fake.host, pixel.input);
    expect(mira!.anonymousId).toBe("returning");
    pixel.emit({
      name: "visitorConsentCollected",
      customerPrivacy: { analyticsProcessingAllowed: false, marketingAllowed: false },
    });
    await tick(5);
    expect(mira!.status.analytics).toBe("denied");
    expect(mira!.anonymousId).toBeUndefined();
    expect(pixel.jar.has("mira_aid")).toBe(false);
    pixel.emit({
      name: "product_viewed",
      context: { document: PAGE },
      data: { productVariant: variant },
    });
    await mira!.flush();
    expect(fake.events().at(-1)!.anonymous_id).toBeUndefined();
  });

  test("nothing is sent before a page URL is known, then the identify and the event follow", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ analytics: true, customer: "8812" });
    pixel.input.init.context = undefined;
    const mira = await startShopifyPixel(fake.host, pixel.input);
    await mira!.flush();
    expect(fake.events()).toEqual([]);
    pixel.emit({
      name: "product_viewed",
      context: { document: PAGE },
      data: { productVariant: variant },
    });
    await mira!.flush();
    expect(fake.events().map((event) => event.event)).toEqual(["$identify", "product_viewed"]);
    for (const event of fake.events()) expect(event.context.page.url).toBe(PAGE.location.href);
  });

  test("a customer is not remembered between checkouts: no cookie carries them to the next buyer", async () => {
    const fake = fakePixel({ analytics: true, customer: "8812" });
    const first = fakeHost();
    const mira = await startShopifyPixel(first.host, fake.input);
    await mira!.flush();
    expect(fake.jar.has("mira_uid")).toBe(false);

    // A guest on the same device: the page names no customer, so nothing names one.
    const next = fakeHost();
    const guest = fakePixel({ analytics: true, cookies: Object.fromEntries(fake.jar) });
    const other = await startShopifyPixel(next.host, guest.input);
    guest.emit({
      name: "product_viewed",
      context: { document: PAGE },
      data: { productVariant: variant },
    });
    await other!.flush();
    expect(next.events()[0]!.user_id).toBeUndefined();
  });

  test("a no that arrives while the cookie of a yes is being read still removes the cookie", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ cookies: { mira_aid: "earlier" } });
    let finishRead: (() => void) | undefined;
    const { cookie } = pixel.input.browser;
    const read = async (name: string) => pixel.jar.get(name);
    cookie.get = (name) =>
      new Promise((resolve) => {
        finishRead = () => void read(name).then(resolve);
      });
    const mira = await startShopifyPixel(fake.host, pixel.input);
    pixel.emit({
      name: "visitorConsentCollected",
      customerPrivacy: { analyticsProcessingAllowed: true, marketingAllowed: false },
    });
    await tick(5);
    pixel.emit({
      name: "visitorConsentCollected",
      customerPrivacy: { analyticsProcessingAllowed: false, marketingAllowed: false },
    });
    await tick(5);
    finishRead?.();
    await tick(10);
    expect(mira!.status.analytics).toBe("denied");
    expect(pixel.jar.has("mira_aid")).toBe(false);
  });

  test("a yes, a no and a yes again while the cookie is being read never bring the old id back", async () => {
    const fake = fakeHost();
    const pixel = fakePixel();
    const reads: (() => void)[] = [];
    const { cookie } = pixel.input.browser;
    // The cookie's value at the moment of the read, delivered late (as Shopify's bridge does).
    cookie.get = (name) => {
      const value = pixel.jar.get(name);
      return new Promise((resolve) => {
        reads.push(() => resolve(value));
      });
    };
    const mira = await startShopifyPixel(fake.host, pixel.input);
    pixel.jar.set("mira_aid", "withdrawn");
    const answer = (allowed: boolean) =>
      pixel.emit({
        name: "visitorConsentCollected",
        customerPrivacy: { analyticsProcessingAllowed: allowed, marketingAllowed: false },
      });
    answer(true);
    await tick(5);
    answer(false);
    await tick(5);
    answer(true);
    await tick(5);
    for (const finish of reads.splice(0)) finish();
    await tick(10);
    expect(mira!.status.analytics).toBe("granted");
    expect(mira!.anonymousId).not.toBe("withdrawn");
    expect(pixel.jar.get("mira_aid")).not.toBe("withdrawn");
  });

  test("a setup error is logged, not thrown", async () => {
    const fake = fakeHost();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(await startShopifyPixel(fake.host, {} as ShopifyPixelInput)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("pixel script", () => {
  test("starts from the stub queue and then answers mira(...) calls", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ analytics: false });
    const stub: any = function (...args: unknown[]) {
      (stub.q ||= []).push(args);
    };
    stub("shopifyPixel", pixel.input);
    stub("track", "queued_before_start");
    Object.assign(fake.host, { mira: stub, window: fake.host });
    Object.assign(globalThis, { window: fake.host });
    await import(`./pixel-snippet?${Math.random()}`);
    await tick(20);
    const mira = (fake.host as any).mira;
    expect(mira.loaded).toBe(true);
    mira("track", "after_start");
    await tick(5);
    await mira("flush");
    const names = fake.events().map((event) => event.event);
    expect(names).toEqual(["queued_before_start", "after_start"]);
    delete (globalThis as any).window;
  });
});

describe("pixel script: events through the snippet's own subscribe", () => {
  test("mira('shopifyEvent', event) reports like analytics.subscribe, early and late", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ analytics: true });
    // What the pasted snippet hands over: no `analytics` in the input.
    const { analytics: _unused, ...input } = pixel.input;
    const stub: any = function (...args: unknown[]) {
      (stub.q ||= []).push(args);
    };
    // An event heard before the script loaded waits in the queue, in order.
    stub("shopifyEvent", {
      name: "checkout_started",
      context: { document: PAGE },
      data: { checkout },
    });
    stub("shopifyPixel", input);
    Object.assign(fake.host, { mira: stub, window: fake.host });
    Object.assign(globalThis, { window: fake.host });
    await import(`./pixel-snippet?${Math.random()}`);
    const mira = (fake.host as any).mira;
    // An event heard while the pixel starts is not lost nor reordered.
    mira("shopifyEvent", {
      name: "payment_info_submitted",
      context: { document: PAGE },
      data: { checkout },
    });
    await tick(20);
    mira("shopifyEvent", {
      name: "checkout_completed",
      context: { document: PAGE },
      data: { checkout },
    });
    await tick(5);
    await mira("flush");
    const names = fake.events().map((event) => event.event);
    expect(names.filter((name) => !name.startsWith("$"))).toEqual([
      "checkout_started",
      "payment_info_submitted",
      "checkout_completed",
    ]);
    delete (globalThis as any).window;
  });
});

describe("the time of an event", () => {
  const checkoutEvent = (name: string, timestamp: string | undefined): ShopifyEvent => ({
    name,
    timestamp,
    context: { document: PAGE },
    data: { checkout },
  });

  test("Shopify's own time is the event's time, so a late arrival keeps its place", async () => {
    const fake = fakeHost();
    const pixel = fakePixel({ analytics: true });
    const mira = await startShopifyPixel(fake.host, pixel.input);
    await tick(10);
    const done = new Date(Date.now() - 12_000).toISOString();
    const paid = new Date(Date.now() - 24_000).toISOString();
    // Heard in the wrong order: the payment step after the completed order.
    pixel.emit(checkoutEvent("checkout_completed", done));
    pixel.emit(checkoutEvent("payment_info_submitted", paid));
    await tick(5);
    await mira!.flush();
    const events = fake.events();
    const time = (name: string) => events.find((event) => event.event === name)?.timestamp;
    expect(time("checkout_completed")).toBe(done);
    expect(time("payment_info_submitted")).toBe(paid);
    expect(Date.parse(time("payment_info_submitted")!)).toBeLessThan(
      Date.parse(time("checkout_completed")!),
    );
  });

  test("a missing, broken or far-off time is ignored", async () => {
    expect(eventTime(undefined)).toBeUndefined();
    expect(eventTime("yesterday")).toBeUndefined();
    expect(eventTime(1_700_000_000_000)).toBeUndefined();
    expect(eventTime(new Date(Date.now() + 3 * 86_400_000).toISOString())).toBeUndefined();
    expect(eventTime(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBeUndefined();
    const fake = fakeHost();
    const pixel = fakePixel({ analytics: true });
    const mira = await startShopifyPixel(fake.host, pixel.input);
    await tick(10);
    const before = Date.now();
    pixel.emit(checkoutEvent("checkout_started", "2001-01-01T00:00:00Z"));
    await tick(5);
    await mira!.flush();
    const sent = fake.events().find((event) => event.event === "checkout_started");
    expect(Date.parse(sent!.timestamp!)).toBeGreaterThanOrEqual(before - 1_000);
  });
});

describe("Shopify's event names", () => {
  test("map to the names the Shop checkout funnel template finds", () => {
    const names = [
      mapEvent({ name: "product_viewed", data: { productVariant: variant } })?.name,
      mapEvent({
        name: "product_added_to_cart",
        data: { cartLine: { merchandise: variant, quantity: 1 } },
      })?.name,
      mapEvent({ name: "checkout_started", data: { checkout } })?.name,
      mapEvent({ name: "checkout_completed", data: { checkout } })?.name,
    ];
    expect(names).toEqual([
      "product_viewed",
      "product_added_to_cart",
      "checkout_started",
      "checkout_completed",
    ]);
    expect(mapEvent({ name: "search_submitted" })).toBeUndefined();
  });
});

const privacyOf = (analytics: boolean, marketing: boolean, banner = false) => ({
  analyticsProcessingAllowed: () => analytics,
  marketingAllowed: () => marketing,
  shouldShowBanner: () => banner,
});

describe("storefront consent", () => {
  test("unknown while the banner waits, then the visitor's choice, heard on the document", () => {
    let privacy: any = privacyOf(false, false, true);
    const fake = fakeHost({
      extra: {
        Shopify: {
          get customerPrivacy() {
            return privacy;
          },
        },
      },
    });
    const seen: string[] = [];
    expect(shopify.detect(fake.host)).toBe(true);
    const stop = shopify.subscribe(fake.host, (status) =>
      seen.push(`${status.analytics}/${status.marketing}`),
    );
    privacy = privacyOf(true, false);
    // Shopify dispatches a CustomEvent on `document`; it does not bubble to `window`.
    fake.host.document.dispatchEvent(new CustomEvent("visitorConsentCollected"));
    expect(seen.at(-2)).toBe("unknown/unknown");
    expect(seen.at(-1)).toBe("granted/denied");
    privacy = privacyOf(false, false);
    fake.host.document.dispatchEvent(new CustomEvent("visitorConsentCollected"));
    expect(seen.at(-1)).toBe("denied/denied");
    stop();
    const count = seen.length;
    fake.host.document.dispatchEvent(new CustomEvent("visitorConsentCollected"));
    expect(seen).toHaveLength(count);
  });

  test("loads the Customer Privacy feature when the page has not", () => {
    const loaded: unknown[] = [];
    const fake = fakeHost({
      extra: {
        Shopify: {
          loadFeatures: (features: unknown) => loaded.push(features),
        },
      },
    });
    expect(shopify.detect(fake.host)).toBe(true);
    shopify.subscribe(fake.host, () => {});
    expect(loaded).toEqual([[{ name: "consent-tracking-api", version: "1.0" }]]);
  });

  test("without the option, a Shopify page gets no Shopify adapter", async () => {
    const fake = fakeHost({ extra: { Shopify: { customerPrivacy: privacyOf(true, true) } } });
    const mira = createMira({ key: KEY, host: HOST, consent: "auto" }, fake.host);
    await tick(30);
    expect(mira.status.analytics).toBe("unknown");
  });

  test("with consent: 'shopify', Shopify's answer is used", async () => {
    const fake = fakeHost({ extra: { Shopify: { customerPrivacy: privacyOf(true, false) } } });
    const mira = createMira({ key: KEY, host: HOST, consent: "shopify" }, fake.host);
    await tick(20);
    expect(mira.status).toEqual({ analytics: "granted", marketing: "denied" });
  });

  test('a banner already on the page owns the decision: Shopify\'s "allowed" touches nothing', async () => {
    const fake = fakeHost({
      extra: {
        Shopify: { customerPrivacy: privacyOf(true, true) },
        Cookiebot: { hasResponse: false, consent: {} },
      },
    });
    const mira = createMira({ key: KEY, host: HOST, consent: "shopify" }, fake.host);
    await tick(50);
    expect(mira.status.analytics).toBe("unknown");
    expect(fake.storageReads()).toBe(0);
    expect(fake.storage.data.size).toBe(0);
  });

  test("a banner that is detected but not loaded yet also holds Shopify back", async () => {
    const fake = fakeHost({ extra: { Shopify: { customerPrivacy: privacyOf(true, true) } } });
    // The script tag is there, its global is not (Cookiebot's adapter says nothing yet).
    Object.assign(fake.host.document, {
      querySelector: (selector: string) =>
        selector.includes("consent.cookiebot.") ? { tagName: "SCRIPT" } : null,
    });
    const mira = createMira({ key: KEY, host: HOST, consent: "shopify" }, fake.host);
    await tick(700);
    expect(mira.status.analytics).toBe("unknown");
    expect(fake.storage.data.size).toBe(0);
  });

  test('an explicit "no" is a denial even while shouldShowBanner() still says true', () => {
    const privacy = {
      ...privacyOf(false, false, true),
      currentVisitorConsent: () => ({ analytics: "no", marketing: "" }),
    };
    expect(fromCustomerPrivacy(privacy)).toEqual({ analytics: "denied", marketing: "unknown" });
  });

  test("a banner that shows up after load takes over from Shopify's answer", async () => {
    const fake = fakeHost({ extra: { Shopify: { customerPrivacy: privacyOf(true, true) } } });
    const mira = createMira({ key: KEY, host: HOST, consent: "shopify" }, fake.host);
    await tick(20);
    expect(mira.status.analytics).toBe("granted");
    // Cookiebot arrives late (a tag manager) and the visitor has not answered it yet.
    Object.assign(fake.host, { Cookiebot: { hasResponse: false, consent: {} } });
    await tick(400);
    expect(mira.status.analytics).toBe("unknown");
    Object.assign(fake.host.Cookiebot as object, {
      hasResponse: true,
      consent: { statistics: false, marketing: false },
    });
    fake.host.dispatchEvent(new Event("CookiebotOnDecline"));
    expect(mira.status.analytics).toBe("denied");
    // Shopify's later answers no longer count.
    fake.host.document.dispatchEvent(new CustomEvent("visitorConsentCollected"));
    expect(mira.status.analytics).toBe("denied");
  });
});

/** What survives from one page to the next: the cookie jar, the tab's storage and the cart. */
interface Shop {
  jar: Map<string, string>;
  stored: Map<string, string>;
  posts: { url: string; body: any; keepalive?: boolean }[];
  failPosts: boolean;
  /** How often a page read `document.cookie`. */
  cookieReads: number;
}
const shop = (): Shop => ({
  jar: new Map([["cart", "token-1"]]),
  stored: new Map(),
  posts: [],
  failPosts: false,
  cookieReads: 0,
});

/** One page view of a storefront, with Shopify's consent as given. */
function storefront(
  state: Shop,
  options: {
    root?: string;
    consent?: "shopify" | { analytics: boolean };
    privacy?: ReturnType<typeof privacyOf>;
  } = {},
) {
  const fake = fakeHost({
    extra: {
      Shopify: {
        routes: { root: options.root ?? "/" },
        ...(options.consent === "shopify"
          ? { customerPrivacy: options.privacy ?? privacyOf(true, true) }
          : {}),
      },
      fetch: async (url: string, init: RequestInit) => {
        if (url.endsWith("cart/update.js")) {
          state.posts.push({
            url,
            body: JSON.parse(init.body as string),
            keepalive: init.keepalive,
          });
          return new Response("{}", { status: state.failPosts ? 500 : 200 });
        }
        return new Response(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }), {
          status: 202,
        });
      },
    },
  });
  for (const [key, value] of state.stored) fake.storage.data.set(key, value);
  Object.defineProperty(fake.host.document, "cookie", {
    get: () => {
      state.cookieReads += 1;
      return [...state.jar].map(([key, value]) => `${key}=${value}`).join("; ");
    },
    set: (value: string) => {
      const [pair = "", ...attributes] = value.split(";");
      const [key = "", ...rest] = pair.split("=");
      if (attributes.some((attribute) => attribute.trim() === "Max-Age=0")) state.jar.delete(key);
      else state.jar.set(key, rest.join("="));
    },
  });
  Object.assign(fake.host.location, { protocol: "https:" });
  const mira = createMira(
    {
      key: KEY,
      host: HOST,
      consent: options.consent ?? { analytics: false },
      // Shopify mode wires the hook itself; the other pages bring one.
      onAnonymousId: options.consent === "shopify" ? undefined : shopifyStorefront(fake.host),
    },
    fake.host,
  );
  /** The end of the page: what the next page of the tab starts with. */
  const leave = () => {
    fake.host.dispatchEvent(new Event("pagehide"));
    state.stored = new Map(fake.storage.data);
  };
  return { fake, mira, leave };
}

describe("storefront visitor id", () => {
  test("goes to a cookie and the cart attribute, only with consent", async () => {
    const state = shop();
    const { fake, mira } = storefront(state);
    expect(state.jar.has("mira_aid")).toBe(false);
    expect(state.posts).toEqual([]);

    mira.consent({ analytics: true });
    await tick(5);
    expect(state.jar.get("mira_aid")).toBe(mira.anonymousId!);
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]!.body).toEqual({ attributes: { [CART_ATTRIBUTE]: mira.anonymousId } });

    // The same cart and id are not written again.
    fake.host.dispatchEvent(new Event("pagehide"));
    await tick(5);
    expect(state.posts).toHaveLength(1);

    // A new cart (after an order) is.
    state.jar.set("cart", "token-2");
    fake.host.dispatchEvent(new Event("pagehide"));
    await tick(5);
    expect(state.posts).toHaveLength(2);
    expect(state.posts[1]!.keepalive).toBe(true);
  });

  test("the next page of the tab does not write the same attribute again", async () => {
    const state = shop();
    const first = storefront(state);
    first.mira.consent({ analytics: true });
    await tick(5);
    first.leave();
    const second = storefront(state, { consent: { analytics: true } });
    await tick(5);
    expect(second.mira.anonymousId).toBe(first.mira.anonymousId!);
    expect(state.posts).toHaveLength(1);
  });

  test("a reset visitor id replaces the one on the same cart", async () => {
    const state = shop();
    const { mira } = storefront(state);
    mira.consent({ analytics: true });
    await tick(5);
    const first = mira.anonymousId;
    mira.reset();
    await tick(5);
    expect(mira.anonymousId).not.toBe(first);
    expect(state.posts).toHaveLength(2);
    expect(state.posts[1]!.body.attributes[CART_ATTRIBUTE]).toBe(mira.anonymousId!);
  });

  test("consent withdrawn removes the cookie and empties the cart attribute", async () => {
    const state = shop();
    const { mira } = storefront(state);
    mira.consent({ analytics: true });
    await tick(5);
    mira.consent({ analytics: false });
    await tick(5);
    expect(state.jar.has("mira_aid")).toBe(false);
    expect(state.posts.at(-1)).toMatchObject({
      body: { attributes: { [CART_ATTRIBUTE]: "" } },
      keepalive: true,
    });
    // One request for the clean-up, not one per announcement.
    expect(state.posts.filter((post) => post.body.attributes[CART_ATTRIBUTE] === "")).toHaveLength(
      1,
    );
  });

  test("a revoke while the id is still being written clears at once and again after it, leaving nothing in the tab", async () => {
    const state = shop();
    const { mira, fake } = storefront(state);
    // The cart answers the id's POST late.
    let release: (() => void) | undefined;
    const real = fake.host.fetch;
    Object.assign(fake.host, {
      fetch: (url: string, init: RequestInit) =>
        url.endsWith("cart/update.js") && JSON.parse(init.body as string).attributes._mira_aid
          ? new Promise<Response>((resolve) => {
              release = () => {
                state.posts.push({ url, body: JSON.parse(init.body as string) });
                resolve(new Response("{}", { status: 200 }));
              };
            })
          : real(url, init),
    });
    mira.consent({ analytics: true });
    await tick(5);
    mira.consent({ analytics: false });
    await tick(5);
    // The clear goes out at once (the page may be closing), and again after the id landed.
    expect(state.posts.map((post) => post.body.attributes[CART_ATTRIBUTE] === "")).toEqual([true]);
    release?.();
    await tick(10);
    expect(state.posts.map((post) => post.body.attributes[CART_ATTRIBUTE] === "")).toEqual([
      true,
      false,
      true,
    ]);
    expect(fake.storage.data.has("mira_cart")).toBe(false);
  });

  test("consent withdrawn on another page still cleans up what this one left", async () => {
    const state = shop();
    const first = storefront(state);
    first.mira.consent({ analytics: true });
    await tick(5);
    first.leave();
    // The next page starts denied: no "yes" to revoke, but the cookie and the attribute are there.
    const second = storefront(state, { consent: { analytics: false } });
    await tick(5);
    expect(second.mira.status.analytics).toBe("denied");
    expect(state.jar.has("mira_aid")).toBe(false);
    expect(state.posts.at(-1)!.body).toEqual({ attributes: { [CART_ATTRIBUTE]: "" } });
  });

  test("a failed clean-up is tried again when the page is hidden", async () => {
    const state = shop();
    const first = storefront(state);
    first.mira.consent({ analytics: true });
    await tick(5);
    first.leave();
    state.failPosts = true;
    const second = storefront(state, { consent: { analytics: false } });
    await tick(5);
    const failed = state.posts.length;
    state.failPosts = false;
    second.fake.host.dispatchEvent(new Event("pagehide"));
    await tick(5);
    expect(state.posts.length).toBe(failed + 1);
    expect(state.posts.at(-1)!.body).toEqual({ attributes: { [CART_ATTRIBUTE]: "" } });
    // Cleaned: another hide posts nothing.
    second.fake.host.dispatchEvent(new Event("pagehide"));
    await tick(5);
    expect(state.posts.length).toBe(failed + 1);
  });

  test("a clear lost with the closing page is tried again on the next one", async () => {
    const state = shop();
    const first = storefront(state);
    first.mira.consent({ analytics: true });
    await tick(5);
    first.leave();
    state.failPosts = true;
    const second = storefront(state, { consent: { analytics: false } });
    await tick(5);
    // The page is left and the request never lands; the tab still records the id on the cart.
    second.leave();
    state.failPosts = false;
    state.jar.delete("mira_aid");
    const third = storefront(state, { consent: { analytics: false } });
    await tick(5);
    expect(state.posts.at(-1)!.body).toEqual({ attributes: { [CART_ATTRIBUTE]: "" } });
    expect(third.fake.storage.data.has("mira_cart")).toBe(false);
  });

  test("an id write that may still land after the page is gone is cleared by the next page", async () => {
    const state = shop();
    const { mira, fake, leave } = storefront(state);
    const real = fake.host.fetch;
    // The id's request never answers before the page closes.
    Object.assign(fake.host, {
      fetch: (url: string, init: RequestInit) =>
        url.endsWith("cart/update.js") && JSON.parse(init.body as string).attributes._mira_aid
          ? new Promise<Response>(() => {})
          : real(url, init),
    });
    mira.consent({ analytics: true });
    await tick(5);
    mira.consent({ analytics: false });
    await tick(5);
    leave();
    state.jar.delete("mira_aid");
    const before = state.posts.length;
    const next = storefront(state, { consent: { analytics: false } });
    await tick(5);
    expect(state.posts.length).toBeGreaterThan(before);
    expect(state.posts.at(-1)!.body).toEqual({ attributes: { [CART_ATTRIBUTE]: "" } });
    expect(next.fake.storage.data.has("mira_cart_open")).toBe(false);
  });

  test("re-granting within the round trip ends with the new id on the cart, never empty", async () => {
    const state = shop();
    const { mira, fake } = storefront(state);
    const real = fake.host.fetch;
    const waiting: (() => void)[] = [];
    // Every write of an id answers late, in the order it was sent.
    Object.assign(fake.host, {
      fetch: (url: string, init: RequestInit) =>
        url.endsWith("cart/update.js") && JSON.parse(init.body as string).attributes._mira_aid
          ? new Promise<Response>((resolve) => {
              waiting.push(() => {
                state.posts.push({ url, body: JSON.parse(init.body as string) });
                resolve(new Response("{}", { status: 200 }));
              });
            })
          : real(url, init),
    });
    mira.consent({ analytics: true });
    await tick(5);
    const first = mira.anonymousId;
    mira.consent({ analytics: false });
    await tick(5);
    mira.consent({ analytics: true });
    await tick(5);
    const second = mira.anonymousId;
    expect(second).not.toBe(first);
    for (let round = 0; round < 4; round += 1) {
      waiting.shift()?.();
      await tick(10);
    }
    const written = state.posts.map((post) => post.body.attributes[CART_ATTRIBUTE]);
    expect(written.at(-1)).toBe(second!);
  });

  test("clears are not repeated: one at once and one after the write in flight", async () => {
    const state = shop();
    const { mira, fake } = storefront(state);
    const real = fake.host.fetch;
    let release: (() => void) | undefined;
    Object.assign(fake.host, {
      fetch: (url: string, init: RequestInit) =>
        url.endsWith("cart/update.js") && JSON.parse(init.body as string).attributes._mira_aid
          ? new Promise<Response>((resolve) => {
              release = () => {
                state.posts.push({ url, body: JSON.parse(init.body as string) });
                resolve(new Response("{}", { status: 200 }));
              };
            })
          : real(url, init),
    });
    mira.consent({ analytics: true });
    await tick(5);
    mira.consent({ analytics: false });
    mira.consent({ analytics: false });
    fake.host.dispatchEvent(new Event("pagehide"));
    fake.host.dispatchEvent(new Event("pagehide"));
    await tick(5);
    release?.();
    await tick(10);
    const clears = state.posts.filter((post) => post.body.attributes[CART_ATTRIBUTE] === "");
    expect(clears).toHaveLength(2);
  });

  test("a visitor who never consented is looked for once per page, not per signal", async () => {
    const state = shop();
    const { mira, fake } = storefront(state);
    mira.consent({ analytics: false });
    mira.consent({ analytics: false });
    mira.consent({ analytics: false });
    await tick(5);
    expect(state.cookieReads).toBe(1);
    // The tab's two records, read once (the session object is fetched once as well).
    expect(fake.storage.accesses).toBeLessThanOrEqual(2);
    expect(state.posts).toEqual([]);
  });

  test("consent('shopify') at runtime on a page where Shopify says no cleans up the earlier visit", async () => {
    const state = shop();
    state.jar.set("mira_aid", "earlier");
    const fake = fakeHost({
      extra: {
        Shopify: { routes: { root: "/" }, customerPrivacy: privacyOf(false, false) },
        fetch: async (url: string, init: RequestInit) => {
          if (url.endsWith("cart/update.js")) {
            state.posts.push({ url, body: JSON.parse(init.body as string) });
          }
          return new Response(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }), {
            status: 202,
          });
        },
      },
    });
    Object.defineProperty(fake.host.document, "cookie", {
      get: () => [...state.jar].map(([key, value]) => `${key}=${value}`).join("; "),
      set: (value: string) => {
        const [pair = "", ...attributes] = value.split(";");
        const [key = "", ...rest] = pair.split("=");
        if (attributes.some((attribute) => attribute.trim() === "Max-Age=0")) state.jar.delete(key);
        else state.jar.set(key, rest.join("="));
      },
    });
    const mira = createMira({ key: KEY, host: HOST, consent: { analytics: false } }, fake.host);
    mira.consent("shopify");
    await tick(20);
    expect(mira.status.analytics).toBe("denied");
    expect(state.jar.has("mira_aid")).toBe(false);
    expect(state.posts.at(-1)!.body).toEqual({ attributes: { [CART_ATTRIBUTE]: "" } });
  });

  test("consent: 'shopify' alone shares the id (the npm way, no hook passed)", async () => {
    const state = shop();
    const fake = fakeHost({
      extra: { Shopify: { routes: { root: "/" }, customerPrivacy: privacyOf(true, true) } },
    });
    Object.defineProperty(fake.host.document, "cookie", {
      get: () => [...state.jar].map(([key, value]) => `${key}=${value}`).join("; "),
      set: (value: string) => {
        const [pair = ""] = value.split(";");
        const [key = "", ...rest] = pair.split("=");
        state.jar.set(key, rest.join("="));
      },
    });
    const mira = createMira({ key: KEY, host: HOST, consent: "shopify" }, fake.host);
    await tick(20);
    expect(state.jar.get("mira_aid")).toBe(mira.anonymousId!);
  });

  test("an early clear that is still on its way does not overtake the id written after it", async () => {
    const state = shop();
    const { mira, fake } = storefront(state);
    const real = fake.host.fetch;
    const held: { value: string; release: () => void }[] = [];
    const landed: string[] = [];
    // Every write answers late, and what has landed so far is kept in order.
    Object.assign(fake.host, {
      fetch: (url: string, init: RequestInit) =>
        url.endsWith("cart/update.js")
          ? new Promise<Response>((resolve) => {
              const value = JSON.parse(init.body as string).attributes._mira_aid as string;
              held.push({
                value,
                release: () => {
                  landed.push(value === "" ? "clear" : "id");
                  resolve(new Response("{}", { status: 200 }));
                },
              });
            })
          : real(url, init),
    });
    mira.consent({ analytics: true });
    await tick(5);
    mira.consent({ analytics: false });
    await tick(5);
    mira.consent({ analytics: true });
    await tick(5);
    // id1 and the early clear are out; the second id waits for both.
    expect(held.map((request) => request.value === "")).toEqual([false, true]);
    held[0]!.release();
    await tick(10);
    expect(held).toHaveLength(2);
    held[1]!.release();
    await tick(10);
    expect(held).toHaveLength(3);
    held[2]!.release();
    await tick(10);
    expect(landed).toEqual(["id", "clear", "id"]);
  });

  test("a no, a yes and a no again while a clear is on its way never write the second id", async () => {
    const state = shop();
    const { mira, fake } = storefront(state);
    const real = fake.host.fetch;
    const held: { value: string; release: () => void }[] = [];
    Object.assign(fake.host, {
      fetch: (url: string, init: RequestInit) =>
        url.endsWith("cart/update.js")
          ? new Promise<Response>((resolve) => {
              held.push({
                value: JSON.parse(init.body as string).attributes._mira_aid as string,
                release: () => {
                  state.posts.push({ url, body: JSON.parse(init.body as string) });
                  resolve(new Response("{}", { status: 200 }));
                },
              });
            })
          : real(url, init),
    });
    mira.consent({ analytics: true });
    await tick(5);
    mira.consent({ analytics: false });
    await tick(5);
    mira.consent({ analytics: true });
    await tick(5);
    const second = mira.anonymousId;
    held[0]!.release();
    await tick(5);
    mira.consent({ analytics: false });
    await tick(5);
    for (let round = 0; round < 6; round += 1) {
      for (const request of held.splice(0)) request.release();
      await tick(10);
    }
    const written = state.posts.map((post) => post.body.attributes[CART_ATTRIBUTE] as string);
    expect(second).toBeDefined();
    expect(written).not.toContain(second!);
    expect(written.at(-1)).toBe("");
  });

  test("nothing goes to the tab when consent ended and the cart is gone while an id was on its way", async () => {
    const state = shop();
    const { mira, fake } = storefront(state);
    const real = fake.host.fetch;
    let release: (() => void) | undefined;
    Object.assign(fake.host, {
      fetch: (url: string, init: RequestInit) =>
        url.endsWith("cart/update.js")
          ? new Promise<Response>((resolve) => {
              release = () => resolve(new Response("{}", { status: 200 }));
              void init;
            })
          : real(url, init),
    });
    mira.consent({ analytics: true });
    await tick(5);
    state.jar.delete("cart");
    mira.consent({ analytics: false });
    await tick(5);
    release?.();
    await tick(10);
    expect(fake.storage.data.has("mira_cart")).toBe(false);
  });

  test("a deletion cookie is written only where the cookie may be", async () => {
    const state = shop();
    const deletes: string[] = [];
    const { mira, fake } = storefront(state);
    const jar = Object.getOwnPropertyDescriptor(fake.host.document, "cookie")!;
    Object.defineProperty(fake.host.document, "cookie", {
      get: () =>
        state.jar.size && [...state.jar].map(([key, value]) => `${key}=${value}`).join("; "),
      set: (value: string) => {
        if (value.includes("Max-Age=0")) deletes.push(value);
        jar.set!(value);
      },
    });
    mira.consent({ analytics: false });
    mira.consent({ analytics: false });
    await tick(5);
    expect(deletes).toEqual([]);
  });

  test("a visitor who never consented and has no cart makes no request", async () => {
    const state = shop();
    state.jar.delete("cart");
    const { mira } = storefront(state);
    mira.consent({ analytics: true });
    await tick(5);
    mira.consent({ analytics: false });
    await tick(5);
    expect(state.posts).toEqual([]);
    const clean = shop();
    const page = storefront(clean);
    await tick(5);
    page.fake.host.dispatchEvent(new Event("pagehide"));
    expect(clean.posts).toEqual([]);
  });

  test("the update goes under the shop's locale path", async () => {
    const state = shop();
    const { mira } = storefront(state, { root: "/de/" });
    mira.consent({ analytics: true });
    await tick(5);
    expect(state.posts[0]!.url).toBe("/de/cart/update.js");
  });
});

describe("a banner found after boot", () => {
  const cookiebot = (consent?: { statistics: boolean; marketing: boolean }) => ({
    hasResponse: consent !== undefined,
    consent: consent ?? {},
  });

  async function page(state: Shop, banner?: ReturnType<typeof cookiebot>) {
    const shopPage = storefront(state, { consent: "shopify" });
    await tick(20);
    expect(shopPage.mira.status.analytics).toBe("granted");
    // The banner's script arrives later (a tag manager, an app embed).
    if (banner) Object.assign(shopPage.fake.host, { Cookiebot: banner });
    await tick(400);
    return shopPage;
  }

  test("with a stored yes the visitor keeps the id, on every page, and the cart is not touched", async () => {
    const state = shop();
    const first = await page(state, cookiebot({ statistics: true, marketing: true }));
    const id = first.mira.anonymousId;
    expect(first.mira.status.analytics).toBe("granted");
    first.leave();
    const second = await page(state, cookiebot({ statistics: true, marketing: true }));
    expect(second.mira.anonymousId).toBe(id!);
    // One write of the id on the first page; no clear, no second id.
    expect(state.posts.map((post) => post.body.attributes[CART_ATTRIBUTE])).toEqual([id!]);
  });

  test("with a stored no it revokes: the cookie goes and the cart is emptied", async () => {
    const state = shop();
    const shopPage = await page(state, cookiebot({ statistics: false, marketing: false }));
    expect(shopPage.mira.status.analytics).toBe("denied");
    expect(state.jar.has("mira_aid")).toBe(false);
    expect(state.posts.at(-1)!.body.attributes[CART_ATTRIBUTE]).toBe("");
  });

  test("not answered yet it ends unknown", async () => {
    const state = shop();
    const shopPage = await page(state, cookiebot());
    expect(shopPage.mira.status.analytics).toBe("unknown");
  });
});

const gtag = function (..._args: unknown[]) {
  // oxlint-disable-next-line prefer-rest-params -- the dataLayer holds `arguments` objects
  return arguments;
};
/** Google's snippet before the banner answered: Consent Mode's default is "granted". */
const granted = () => [
  gtag("consent", "default", { analytics_storage: "granted", ad_storage: "granted" }),
];

describe("a choice made before init", () => {
  test("a denial is init's own: Consent Mode's default never grants first", async () => {
    const fake = fakeHost({ extra: { dataLayer: granted() } });
    const mira = createMira(undefined, fake.host);
    mira.consent({ analytics: false });
    mira.init({ key: KEY, host: HOST });
    await tick(700);
    expect(mira.status.analytics).toBe("denied");
    expect(fake.storage.data.size).toBe(0);
  });

  test("'shopify' before init wires the cookie and the cart", async () => {
    const state = shop();
    const fake = fakeHost({
      extra: { Shopify: { routes: { root: "/" }, customerPrivacy: privacyOf(true, true) } },
    });
    Object.defineProperty(fake.host.document, "cookie", {
      get: () => [...state.jar].map(([key, value]) => `${key}=${value}`).join("; "),
      set: (value: string) => {
        const [pair = ""] = value.split(";");
        const [key = "", ...rest] = pair.split("=");
        state.jar.set(key, rest.join("="));
      },
    });
    const mira = createMira(undefined, fake.host);
    mira.consent("shopify");
    mira.init({ key: KEY, host: HOST });
    await tick(20);
    expect(state.jar.get("mira_aid")).toBe(mira.anonymousId!);
  });

  test("consent('shopify') at runtime follows Shopify and wires the cart too", async () => {
    const state = shop();
    const fake = fakeHost({
      extra: { Shopify: { routes: { root: "/" }, customerPrivacy: privacyOf(true, true) } },
    });
    Object.defineProperty(fake.host.document, "cookie", {
      get: () => [...state.jar].map(([key, value]) => `${key}=${value}`).join("; "),
      set: (value: string) => {
        const [pair = ""] = value.split(";");
        const [key = "", ...rest] = pair.split("=");
        state.jar.set(key, rest.join("="));
      },
    });
    const mira = createMira({ key: KEY, host: HOST, consent: { analytics: false } }, fake.host);
    mira.consent("shopify");
    await tick(20);
    expect(mira.status.analytics).toBe("granted");
    expect(state.jar.get("mira_aid")).toBe(mira.anonymousId!);
  });
});

describe("script tag boot", () => {
  async function boot(
    extra: Record<string, unknown>,
    writes: string[],
    consent = "shopify",
    withKey = true,
  ) {
    const fake = fakeHost({ extra });
    Object.defineProperty(fake.host.document, "cookie", {
      get: () => "",
      set: (value: string) => {
        writes.push(value);
      },
    });
    const script = {
      dataset: withKey ? { key: KEY, host: HOST, consent } : { consent },
      src: `${HOST}/sdk/mira.js`,
    };
    Object.assign(globalThis, {
      window: fake.host,
      document: Object.assign(fake.host.document, { currentScript: script }),
    });
    await import(`../snippet?${Math.random()}`);
    await tick(20);
    return fake;
  }
  const forget = () => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  };

  test("a queued denial survives a script tag without a key and a later init", async () => {
    const stub: any = function (...args: unknown[]) {
      (stub.q ||= []).push(args);
    };
    stub("consent", { analytics: false, marketing: false });
    stub("init", { key: KEY, host: HOST });
    const writes: string[] = [];
    const fake = await boot({ dataLayer: granted(), mira: stub }, writes, "auto", false);
    await tick(700);
    expect(fake.storage.data.size).toBe(0);
    forget();
  });

  test("on a Shopify storefront the visitor id is shared with checkout", async () => {
    const writes: string[] = [];
    const fake = await boot(
      { Shopify: { routes: { root: "/" }, customerPrivacy: privacyOf(true, true) } },
      writes,
    );
    expect(fake.storage.data.get("mira_aid")).toBeDefined();
    expect(writes[0]).toContain(`mira_aid=${fake.storage.data.get("mira_aid")}`);
    forget();
  });

  test('a Shopify page without data-consent="shopify" behaves like any other', async () => {
    const writes: string[] = [];
    const fake = await boot(
      { Shopify: { customerPrivacy: privacyOf(true, true) } },
      writes,
      "granted",
    );
    expect(fake.storage.data.get("mira_aid")).toBeDefined();
    expect(writes).toEqual([]);
    forget();
  });

  test("a page that is not Shopify never gets the hook", async () => {
    const writes: string[] = [];
    const fake = await boot({}, writes, "granted");
    expect(fake.storage.data.get("mira_aid")).toBeDefined();
    expect(writes).toEqual([]);
    forget();
  });
});
