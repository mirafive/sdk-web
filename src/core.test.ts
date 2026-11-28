import { describe, expect, test } from "bun:test";

import type { ConsentStatus } from "./consent/types";
import { createCore, type ShopifyParts } from "./core";
import { fakeHost, tick } from "./test/fake-host";

const KEY = "pk_test_123";
const HOST = "https://ingest.example";
const GRANTED: ConsentStatus = { analytics: "granted", marketing: "granted" };

/** Shopify mode's parts as a file that arrives when the test says so. */
function lateShopify() {
  const seen = { follows: 0, stops: 0, hooked: 0, ids: [] as (string | undefined)[] };
  const parts: ShopifyParts = {
    follow(_host, emit) {
      seen.follows += 1;
      // As Shopify's adapter does: "unknown" while it looks for the API, then the API's answer.
      emit({ analytics: "unknown", marketing: "unknown" });
      emit(GRANTED);
      return () => {
        seen.stops += 1;
      };
    },
    storefront() {
      seen.hooked += 1;
      return (id) => seen.ids.push(id);
    },
  };
  let arrive: (value: ShopifyParts) => void = () => {};
  let fail: (error: Error) => void = () => {};
  let loads = 0;
  const load = () => {
    loads += 1;
    return new Promise<ShopifyParts>((resolve, reject) => {
      arrive = resolve;
      fail = reject;
    });
  };
  return {
    seen,
    load,
    loads: () => loads,
    arrive: () => arrive(parts),
    fail: () => fail(new Error("blocked")),
  };
}

const storefront = () => fakeHost({ extra: { Shopify: { routes: { root: "/" } } } });

describe("Shopify mode's parts, loaded when the page asks for the mode", () => {
  test("follow Shopify and wire the hook once they are there", async () => {
    const shopify = lateShopify();
    const fake = storefront();
    const mira = createCore({ key: KEY, host: HOST, consent: "shopify" }, fake.host, {
      shopify: shopify.load,
    });
    expect(shopify.loads()).toBe(1);
    expect(mira.status.analytics).toBe("unknown");
    expect(fake.storage.data.size).toBe(0);
    shopify.arrive();
    await tick();
    expect(shopify.seen).toMatchObject({ follows: 1, hooked: 1 });
    expect(mira.status.analytics).toBe("granted");
    expect(shopify.seen.ids).toEqual([mira.anonymousId]);
  });

  test("arriving after the first pageview began to wait, give it Shopify's answer", async () => {
    const shopify = lateShopify();
    const fake = storefront();
    const mira = createCore({ key: KEY, host: HOST, consent: "shopify" }, fake.host, {
      shopify: shopify.load,
    });
    await tick(50);
    shopify.arrive();
    await tick();
    await mira.flush();
    expect(fake.events().map((event) => [event.event, event.consent.analytics])).toEqual([
      ["$pageview", "granted"],
    ]);
  });

  test("are not asked for by a page in another mode", () => {
    const shopify = lateShopify();
    createCore({ key: KEY, host: HOST, consent: "auto" }, storefront().host, {
      shopify: shopify.load,
    });
    createCore({ key: KEY, host: HOST, consent: { analytics: true } }, storefront().host, {
      shopify: shopify.load,
    });
    expect(shopify.loads()).toBe(0);
  });

  test("arriving after the page chose another mode, change nothing", async () => {
    const shopify = lateShopify();
    const fake = storefront();
    const mira = createCore({ key: KEY, host: HOST, consent: "shopify" }, fake.host, {
      shopify: shopify.load,
    });
    mira.consent({ analytics: false, marketing: false });
    shopify.arrive();
    await tick();
    expect(shopify.seen).toMatchObject({ follows: 0, hooked: 0 });
    expect(mira.status.analytics).toBe("denied");
    expect(fake.storage.data.size).toBe(0);
  });

  test("that cannot be loaded leave the consent unknown: nothing is stored, events still go", async () => {
    const shopify = lateShopify();
    const fake = storefront();
    const mira = createCore({ key: KEY, host: HOST, consent: "shopify" }, fake.host, {
      shopify: shopify.load,
    });
    shopify.fail();
    mira.track("viewed_product");
    await mira.flush();
    expect(mira.status.analytics).toBe("unknown");
    expect(fake.storage.data.size).toBe(0);
    expect(fake.events().map((event) => event.event)).toContain("viewed_product");
    expect(fake.events().every((event) => event.anonymous_id === undefined)).toBe(true);
  });

  test("once there, serve a later switch back to the mode at once", async () => {
    const shopify = lateShopify();
    const mira = createCore({ key: KEY, host: HOST, consent: "shopify" }, storefront().host, {
      shopify: shopify.load,
    });
    shopify.arrive();
    await tick();
    mira.consent({ analytics: false });
    expect(shopify.seen.stops).toBe(1);
    mira.consent("shopify");
    expect(shopify.loads()).toBe(1);
    expect(shopify.seen.follows).toBe(2);
    expect(mira.status.analytics).toBe("granted");
  });
});

describe("an instance without a part", () => {
  test("captures no engagement, clicks or SPA pageviews without the capture part", async () => {
    const fake = fakeHost();
    const mira = createCore({ key: KEY, host: HOST, consent: { analytics: true } }, fake.host, {});
    fake.navigate("/next");
    await tick(150);
    await mira.flush();
    expect(fake.events().map((event) => event.event)).toEqual(["$pageview"]);
  });

  test("follows no banner without adapters", async () => {
    const fake = fakeHost({
      extra: { Cookiebot: { hasResponse: true, consent: { statistics: true } } },
    });
    const mira = createCore({ key: KEY, host: HOST }, fake.host, {});
    await tick(300);
    expect(mira.status.analytics).toBe("unknown");
  });
});
