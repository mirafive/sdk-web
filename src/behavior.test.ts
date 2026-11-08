import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { createMira, type MiraOptions } from "./mira";
import { fakeElement, fakeHost, tick, type FakeHost } from "./test/fake-host";

const base: MiraOptions = { key: "pk_test_123", host: "https://ingest.example" };
const t0 = { analytics: false, marketing: false };

afterEach(() => {
  mock.restore();
});

/**
 * Freezes `Date.now`, so engaged time is exact; `advance` moves the clock. It starts an hour back
 * because UUIDv7 never goes back in time: a clock in the future would leak into later tests.
 */
function clock() {
  let now = Date.now() - 60 * 60 * 1000;
  spyOn(Date, "now").mockImplementation(() => now);
  return {
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function setVisibility(fake: FakeHost, state: "visible" | "hidden") {
  Object.assign(fake.host.document, { visibilityState: state });
  fake.host.document.dispatchEvent(new Event("visibilitychange"));
}

const named = (events: Record<string, any>[], name: string) =>
  events.filter((event) => event.event === name);
const beaconed = (fake: FakeHost) => fake.beacons.flatMap((beacon) => beacon.body.events);

describe("engagement", () => {
  test("is sent on SPA navigation before the next pageview, with the page being left", async () => {
    const time = clock();
    const fake = fakeHost();
    const mira = createMira({ ...base, consent: t0 }, fake.host);
    time.advance(5_000);
    // Scrolled to half of the page (720 px viewport, 2880 px document).
    Object.assign(fake.host, { scrollY: 720 });
    fake.host.dispatchEvent(new Event("scroll"));
    await tick(150);

    fake.navigate("/pricing?plan=pro");
    Object.assign(fake.host.document, { title: "Pricing" });
    await tick(150);
    await mira.flush();

    const events = fake.events();
    expect(events.map((event) => event.event)).toEqual(["$pageview", "$engagement", "$pageview"]);
    const [, engagement, next] = events;
    expect(engagement?.type).toBe("track");
    expect(engagement?.properties).toEqual({ engaged_ms: 5_000, scroll_depth: 50 });
    expect(engagement?.context.page).toEqual({
      url: "https://shop.example/landing?utm_source=news",
      referrer: "https://www.google.com/",
      title: "Landing",
    });
    expect(next?.context.page.url).toBe("https://shop.example/pricing?plan=pro");
    expect(next?.context.page.title).toBe("Pricing");
  });

  test("is not sent when the page was left within a second", async () => {
    const time = clock();
    const fake = fakeHost();
    const mira = createMira({ ...base, consent: t0 }, fake.host);
    time.advance(900);
    fake.navigate("/pricing");
    await tick(150);
    time.advance(500);
    fake.host.dispatchEvent(new Event("pagehide"));
    await mira.flush();
    expect(named([...fake.events(), ...beaconed(fake)], "$engagement")).toHaveLength(0);
  });

  test("goes out with the beacon on page hide, without the time the page was hidden", () => {
    const time = clock();
    const fake = fakeHost();
    createMira({ ...base, consent: t0 }, fake.host);
    time.advance(2_000);
    setVisibility(fake, "hidden");
    // `pagehide` right after `visibilitychange` adds nothing new.
    fake.host.dispatchEvent(new Event("pagehide"));
    time.advance(60_000);
    setVisibility(fake, "visible");
    time.advance(1_500);
    setVisibility(fake, "hidden");

    const engagements = named(beaconed(fake), "$engagement");
    expect(engagements.map((event) => event.properties)).toEqual([
      { engaged_ms: 2_000, scroll_depth: 25 },
      { engaged_ms: 1_500, scroll_depth: 25 },
    ]);
    // The first beacon carries the pageview and then its engagement.
    expect(fake.beacons[0]?.body.events.map((event) => event.event)).toEqual([
      "$pageview",
      "$engagement",
    ]);
  });

  test("a short page that needs no scrolling counts as read to the end", () => {
    const time = clock();
    const fake = fakeHost();
    Object.assign(fake.host.document, { documentElement: { scrollHeight: 700 } });
    createMira({ ...base, consent: t0 }, fake.host);
    time.advance(3_000);
    fake.host.dispatchEvent(new Event("pagehide"));
    expect(named(beaconed(fake), "$engagement")[0]?.properties.scroll_depth).toBe(100);
  });

  test("autocapture.engagement: false turns it off", () => {
    const time = clock();
    const fake = fakeHost();
    createMira({ ...base, consent: t0, autocapture: { engagement: false } }, fake.host);
    time.advance(5_000);
    fake.host.dispatchEvent(new Event("pagehide"));
    expect(beaconed(fake).map((event) => event.event)).toEqual(["$pageview"]);
  });
});

describe("links", () => {
  const options: MiraOptions = { ...base, consent: t0, autocapture: { pageviews: false } };

  test("an outbound click sends the bare URL and the domain", async () => {
    const fake = fakeHost();
    const mira = createMira(options, fake.host);
    const link = fakeElement({ href: "https://partner.example/offer?email=a@example.com#top" });
    // The click lands on a child of the link.
    fake.dispatch("click", fakeElement({}, link.element).element);
    await mira.flush();
    const [event] = fake.events();
    expect(event?.event).toBe("$outbound_click");
    expect(event?.properties).toEqual({
      url: "https://partner.example/offer",
      domain: "partner.example",
    });
  });

  test("links to the own site, www or not, and non-web links are not outbound", async () => {
    const fake = fakeHost();
    const mira = createMira(options, fake.host);
    for (const href of [
      "/pricing",
      "https://www.shop.example/about",
      "mailto:hello@shop.example",
      "tel:+49301234",
      "javascript:void(0)",
    ]) {
      fake.dispatch("click", fakeElement({ href }).element);
    }
    await mira.flush();
    expect(fake.events()).toHaveLength(0);
  });

  test("a middle click counts, a right click does not", async () => {
    const fake = fakeHost();
    const mira = createMira(options, fake.host);
    const link = fakeElement({ href: "https://partner.example/" });
    fake.dispatch("auxclick", link.element, { button: 1 });
    fake.dispatch("auxclick", link.element, { button: 2 });
    await mira.flush();
    expect(fake.events().map((event) => event.event)).toEqual(["$outbound_click"]);
  });

  test("a file link is a download, also on another host, and loses its query", async () => {
    const fake = fakeHost();
    const mira = createMira(options, fake.host);
    fake.dispatch("click", fakeElement({ href: "/files/Price-List.PDF?token=secret" }).element);
    fake.dispatch("click", fakeElement({ href: "https://cdn.example/app.zip" }).element);
    fake.dispatch("click", fakeElement({ href: "/export", download: "report.csv" }).element);
    fake.dispatch("click", fakeElement({ href: "/export", download: "" }).element);
    await mira.flush();
    const events = fake.events();
    expect(events.map((event) => event.event)).toEqual([
      "$file_download",
      "$file_download",
      "$file_download",
      "$file_download",
    ]);
    expect(events.map((event) => event.properties)).toEqual([
      { url: "https://shop.example/files/Price-List.PDF", extension: "pdf" },
      { url: "https://cdn.example/app.zip", extension: "zip" },
      { url: "https://shop.example/export", extension: "csv" },
      { url: "https://shop.example/export" },
    ]);
  });

  test("with downloads off, a file on another host is an outbound click", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...options, autocapture: { pageviews: false, downloads: false } },
      fake.host,
    );
    fake.dispatch("click", fakeElement({ href: "/files/a.pdf" }).element);
    fake.dispatch("click", fakeElement({ href: "https://cdn.example/a.pdf" }).element);
    await mira.flush();
    expect(fake.events().map((event) => event.event)).toEqual(["$outbound_click"]);
  });
});

describe("forms", () => {
  test("a submit sends id, name and the action path, and never reads a field", async () => {
    const fake = fakeHost();
    const mira = createMira({ ...base, consent: t0, autocapture: { pageviews: false } }, fake.host);
    const form = fakeElement({
      id: "signup",
      name: "newsletter",
      action: "https://shop.example/subscribe?src=footer#done",
    });
    fake.dispatch("submit", form.element);
    // Without an action, a form posts to the page itself.
    fake.dispatch("submit", fakeElement({}).element);
    await mira.flush();

    const [first, second] = fake.events();
    expect(first?.event).toBe("$form_submit");
    expect(first?.properties).toEqual({
      form_id: "signup",
      form_name: "newsletter",
      action: "/subscribe",
    });
    expect(second?.properties).toEqual({ action: "/landing" });
    expect(new Set(form.reads)).toEqual(new Set(["closest", "getAttribute"]));
  });

  test("autocapture: false adds no listeners at all", async () => {
    const fake = fakeHost();
    const mira = createMira({ ...base, consent: t0, autocapture: false }, fake.host);
    fake.dispatch("submit", fakeElement({ id: "x" }).element);
    fake.dispatch("click", fakeElement({ href: "https://partner.example/" }).element);
    fake.host.dispatchEvent(new Event("pagehide"));
    await mira.flush();
    expect(fake.events()).toHaveLength(0);
    expect(fake.beacons).toHaveLength(0);
  });
});

test("behavior events are T0: no ids and no storage access", async () => {
  const time = clock();
  const fake = fakeHost();
  const mira = createMira({ ...base, consent: t0 }, fake.host);
  fake.dispatch("click", fakeElement({ href: "https://partner.example/" }).element);
  fake.dispatch("click", fakeElement({ href: "/a.pdf" }).element);
  fake.dispatch("submit", fakeElement({ id: "f" }).element);
  time.advance(2_000);
  fake.navigate("/next");
  await tick(150);
  await mira.flush();

  const names = fake.events().map((event) => event.event);
  expect(names).toEqual([
    "$pageview",
    "$outbound_click",
    "$file_download",
    "$form_submit",
    "$engagement",
    "$pageview",
  ]);
  for (const event of fake.events()) {
    expect(event.anonymous_id).toBeUndefined();
    expect(event.consent).toEqual({ analytics: "denied", marketing: "denied" });
  }
  expect(fake.storageReads()).toBe(0);
});
