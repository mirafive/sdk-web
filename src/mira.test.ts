import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { validateEvent } from "@mirafive/protocol";

import { createMira, type MiraOptions } from "./mira";
import { fakeHost, tick } from "./test/fake-host";

const KEY = "pk_test_123";
const base: MiraOptions = { key: KEY, host: "https://ingest.example" };

afterEach(() => {
  // Some tests pin Math.random to make backoff deterministic.
  (Math.random as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("T0: no analytics consent", () => {
  test("sends events without ids and touches no storage", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: false, marketing: false } },
      fake.host,
    );
    mira.track("signup_started", { plan: "pro" });
    mira.identify("user_1", { email: "a@example.com" });
    mira.group("acme");
    await mira.flush();

    const events = fake.events();
    expect(events.map((event) => event.event)).toEqual(["$pageview", "signup_started"]);
    for (const event of events) {
      expect(event.anonymous_id).toBeUndefined();
      expect(event.user_id).toBeUndefined();
      expect(event.session_id).toBeUndefined();
      expect(event.group_id).toBeUndefined();
      expect(event.consent).toEqual({ analytics: "denied", marketing: "denied" });
      expect(event.context.screen).toBeUndefined();
      expect(event.context.viewport).toBeUndefined();
      expect(event.context.languages).toBeUndefined();
      expect(event.context.timezone).toBeUndefined();
      expect(event.context.device).toBeUndefined();
      expect(event.context.os).toBeUndefined();
      expect(event.context.locale).toBeUndefined();
      expect(event.context.page.url).toBe("https://shop.example/landing?utm_source=news");
    }
    expect(fake.storageReads()).toBe(0);
    // Client hints are a device read too.
    expect(fake.hintCalls()).toBe(0);
  });

  test("never reads the browser's languages; the server takes the language from the request", async () => {
    let languageReads = 0;
    const navigator = {
      get language() {
        languageReads += 1;
        return "de-DE";
      },
      get languages() {
        languageReads += 1;
        return ["de-DE", "de"];
      },
      sendBeacon: () => true,
    };
    const fake = fakeHost({ extra: { navigator } });
    const mira = createMira(
      { ...base, consent: { analytics: "unknown", marketing: "unknown" } },
      fake.host,
    );
    mira.track("viewed_pricing");
    await mira.flush();

    const events = fake.events();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.context).not.toHaveProperty("locale");
      expect(event.context).not.toHaveProperty("languages");
      expect(validateEvent(event)).toEqual([]);
    }
    expect(languageReads).toBe(0);
  });

  test("an unanswered banner (unknown) is T0 too", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: "unknown" }, autocapture: false },
      fake.host,
    );
    mira.track("viewed_pricing");
    await mira.flush();
    expect(fake.events()[0]?.anonymous_id).toBeUndefined();
    expect(fake.events()[0]?.consent).toEqual({ analytics: "unknown", marketing: "unknown" });
    expect(fake.storageReads()).toBe(0);
  });
});

describe("T1: device context", () => {
  test("adds screen, pixel ratio, viewport, languages, time zone and client hints", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: true }, autocapture: false },
      fake.host,
    );
    // The client hints answer asynchronously; the first event goes without them.
    mira.track("first");
    await tick();
    mira.track("second");
    mira.track("third");
    await mira.flush();

    const [first, second, third] = fake.events();
    expect(first?.context.device).toBeUndefined();
    expect(second?.context).toMatchObject({
      screen: { width: 1440, height: 900, density: 2 },
      viewport: { width: 1280, height: 720 },
      languages: ["de-DE", "de", "en"],
      locale: "de-DE",
      device: { model: "Pixel 9" },
      os: { version: "15.0.0" },
    });
    expect(typeof second?.context.timezone).toBe("string");
    expect(third?.context.device).toEqual({ model: "Pixel 9" });
    for (const event of [first, second, third]) expect(validateEvent(event)).toEqual([]);
    // Asked once, then cached in memory.
    expect(fake.hintCalls()).toBe(1);
  });

  test("asks for client hints only once consent is granted", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    mira.track("before");
    await tick();
    expect(fake.hintCalls()).toBe(0);
    mira.consent({ analytics: true });
    await tick();
    mira.track("after");
    await mira.flush();
    expect(fake.hintCalls()).toBe(1);
    expect(fake.events().at(-1)?.context.os).toEqual({ version: "15.0.0" });
  });

  test("an empty model (desktop browsers) is left out", async () => {
    const fake = fakeHost({
      extra: {
        navigator: {
          language: "en-US",
          userAgentData: {
            getHighEntropyValues: async () => ({ model: "", platformVersion: "10.0.0" }),
          },
        },
      },
    });
    const mira = createMira(
      { ...base, consent: { analytics: true }, autocapture: false },
      fake.host,
    );
    await tick();
    mira.track("desk");
    await mira.flush();
    expect(fake.events()[0]?.context.device).toBeUndefined();
    expect(fake.events()[0]?.context.os).toEqual({ version: "10.0.0" });
  });
});

describe("identity and location", () => {
  test("identify sends external ids and drops empty or unknown ones", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: true }, autocapture: false },
      fake.host,
    );
    mira.identify(
      "user_1",
      { plan: "pro" },
      {
        externalIds: {
          stripe_customer: "cus_123",
          shopify_customer: "",
          ...({ hubspot_contact: "1" } as Record<string, string>),
        },
      },
    );
    mira.identify("user_1", {}, { externalIds: { revenuecat_app_user: "   " } });
    await mira.flush();
    const [first, second] = fake.events();
    expect(first?.external_ids).toEqual({ stripe_customer: "cus_123" });
    expect(second?.external_ids).toBeUndefined();
  });

  test("an identify before consent keeps its external ids until consent arrives", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    mira.identify("user_1", { plan: "pro" }, { externalIds: { stripe_customer: "cus_1" } });
    await mira.flush();
    expect(fake.events()).toHaveLength(0);
    mira.consent({ analytics: true });
    await mira.flush();
    const [identify] = fake.events();
    expect(identify).toMatchObject({
      type: "identify",
      user_id: "user_1",
      traits: { plan: "pro" },
      external_ids: { stripe_customer: "cus_1" },
    });
  });

  test("setLocation goes on events only at T1, rounded to 2 decimals", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    mira.setLocation({ latitude: 52.520_008, longitude: 13.404_954 });
    mira.track("t0");
    mira.consent({ analytics: true });
    mira.track("t1");
    mira.setLocation(null);
    mira.track("forgotten");
    await mira.flush();
    const byName = Object.fromEntries(fake.events().map((event) => [event.event, event]));
    expect(byName.t0?.context.location).toBeUndefined();
    expect(byName.t1?.context.location).toEqual({ latitude: 52.52, longitude: 13.4 });
    expect(byName.forgotten?.context.location).toBeUndefined();
  });

  test("an invalid location is ignored, and reset forgets the location", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: true }, autocapture: false },
      fake.host,
    );
    mira.setLocation({ latitude: 48.14, longitude: 11.58 });
    expect(() => mira.setLocation({ latitude: 91, longitude: 0 })).not.toThrow();
    // Script-tag callers may pass anything.
    const nothing: any = undefined;
    expect(() => mira.setLocation(nothing)).not.toThrow();
    mira.track("kept");
    mira.reset();
    mira.track("after_reset");
    await mira.flush();
    const [kept, afterReset] = fake.events();
    expect(kept?.context.location).toEqual({ latitude: 48.14, longitude: 11.58 });
    expect(afterReset?.context.location).toBeUndefined();
  });
});

describe("consent changes", () => {
  test("a grant mid-session creates and persists the anonymous id and sends $consent_changed", async () => {
    const fake = fakeHost();
    const mira = createMira({ ...base, consent: { analytics: false } }, fake.host);
    mira.identify("user_1", { plan: "pro" });
    mira.consent({ analytics: true, marketing: false });
    mira.track("checkout_started");
    await mira.flush();

    const aid = fake.storage.data.get("mira_aid");
    expect(aid).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.storage.data.get("mira_uid")).toBe("user_1");

    const [pageview, changed, identify, checkout] = fake.events();
    expect(pageview?.anonymous_id).toBeUndefined();
    expect(changed?.event).toBe("$consent_changed");
    expect(changed?.anonymous_id).toBe(aid);
    expect(changed?.consent).toEqual({ analytics: "granted", marketing: "denied" });
    // identify traits given before consent are sent once consent arrives.
    expect(identify?.type).toBe("identify");
    expect(identify?.user_id).toBe("user_1");
    expect(identify?.traits).toEqual({ plan: "pro" });
    expect(checkout?.anonymous_id).toBe(aid);
    expect(checkout?.context.screen).toEqual({ width: 1440, height: 900, density: 2 });
    expect(checkout?.context.locale).toBe("de-DE");
  });

  test("consent granted before anything was sent needs no $consent_changed", async () => {
    const fake = fakeHost();
    const mira = createMira({ ...base, consent: { analytics: true } }, fake.host);
    await mira.flush();
    expect(fake.events().map((event) => event.event)).toEqual(["$pageview"]);
    expect(fake.events()[0]?.anonymous_id).toBe(fake.storage.data.get("mira_aid"));
  });

  test("a returning visitor keeps the stored anonymous id", async () => {
    const fake = fakeHost();
    fake.storage.data.set("mira_aid", "0190d6f0-0000-7000-8000-000000000001");
    const mira = createMira(
      { ...base, consent: { analytics: true }, autocapture: false },
      fake.host,
    );
    mira.track("opened");
    await mira.flush();
    expect(fake.events()[0]?.anonymous_id).toBe("0190d6f0-0000-7000-8000-000000000001");
  });

  test("revoking deletes everything stored and falls back to T0", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: true }, autocapture: false },
      fake.host,
    );
    mira.identify("user_1");
    mira.group("acme");
    expect(fake.storage.data.size).toBeGreaterThan(0);

    mira.consent({ analytics: false, marketing: false });
    expect(fake.storage.data.size).toBe(0);
    const reads = fake.storageReads();

    mira.track("after_revoke");
    await mira.flush();
    const last = fake.events().at(-1);
    expect(last?.event).toBe("after_revoke");
    expect(last?.anonymous_id).toBeUndefined();
    expect(last?.user_id).toBeUndefined();
    // Nothing is read or written after the revoke.
    await tick(600);
    expect(fake.storageReads()).toBe(reads);
  });

  test("marketing only changes the consent stamp", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: true, marketing: false }, autocapture: false },
      fake.host,
    );
    mira.track("a");
    mira.consent({ analytics: true, marketing: true });
    mira.track("b");
    await mira.flush();
    const [a, b] = fake.events();
    expect(fake.events()).toHaveLength(2);
    expect(a?.anonymous_id).toBe(b?.anonymous_id);
    expect(b?.consent).toEqual({ analytics: "granted", marketing: "granted" });
  });

  test("Global Privacy Control denies marketing", () => {
    const fake = fakeHost({ extra: { navigator: { language: "en", globalPrivacyControl: true } } });
    const mira = createMira(
      { ...base, consent: { analytics: true, marketing: true }, autocapture: false },
      fake.host,
    );
    expect(mira.status).toEqual({ analytics: "granted", marketing: "denied" });
  });

  test("reset gives a shared device a new anonymous id and forgets the user", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: true }, autocapture: false },
      fake.host,
    );
    mira.identify("user_1");
    const before = fake.storage.data.get("mira_aid");
    mira.reset();
    mira.track("next_person");
    await mira.flush();
    const last = fake.events().at(-1);
    expect(last?.user_id).toBeUndefined();
    expect(last?.anonymous_id).not.toBe(before);
    expect(fake.storage.data.has("mira_uid")).toBe(false);
  });
});

describe("transport", () => {
  test("batches events into one request with key and sent_at", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    for (let index = 0; index < 3; index += 1) mira.track("step", { index });
    await tick(10);
    // Not sent yet: the batch waits up to 2 s for more events.
    expect(fake.requests).toHaveLength(0);
    await mira.flush();
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request?.url).toBe("https://ingest.example/v1/batch");
    expect(request?.keepalive).toBe(true);
    expect(request?.body.key).toBe(KEY);
    expect(request?.body.sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(request?.body.events).toHaveLength(3);
  });

  test("sends at once when 50 events are waiting, never more than 50 per request", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    for (let index = 0; index < 120; index += 1) mira.track("bulk", { index });
    await tick(20);
    expect(fake.requests.length).toBeGreaterThanOrEqual(2);
    await mira.flush();
    expect(fake.requests.map((request) => request.body.events.length)).toEqual([50, 50, 20]);
    expect(new Set(fake.events().map((event) => event.event_id)).size).toBe(120);
  });

  test("retries 5xx, 429 and network errors with the same event ids", async () => {
    spyOn(Math, "random").mockReturnValue(0);
    const fake = fakeHost();
    fake.responses.push(503, "network", 429);
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    mira.track("purchase_clicked");
    mira.track("purchase_confirmed");
    // Sequential on purpose: each flush is one retry.
    // oxlint-disable-next-line no-await-in-loop
    for (let attempt = 0; attempt < 4; attempt += 1) await mira.flush();

    expect(fake.requests).toHaveLength(4);
    const ids = fake.requests.map((request) =>
      request.body.events.map((event) => event.event_id).join(),
    );
    expect(new Set(ids).size).toBe(1);
  });

  test("drops a batch on a final 4xx", async () => {
    const fake = fakeHost();
    fake.responses.push(401);
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    mira.track("lost");
    await mira.flush();
    await mira.flush();
    expect(fake.requests).toHaveLength(1);
  });

  test("hands the queue to sendBeacon on /v1/p when the page is hidden", () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    mira.track("leaving");
    fake.host.dispatchEvent(new Event("pagehide"));
    expect(fake.beacons).toHaveLength(1);
    expect(fake.beacons[0]?.url).toBe("https://ingest.example/v1/p");
    expect(fake.beacons[0]?.body.events[0]?.event).toBe("leaving");
  });

  test("numbers the batches of one page load 1, 2, 3 in one stream", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    for (let index = 0; index < 120; index += 1) mira.track("bulk", { index });
    await mira.flush();
    expect(fake.requests.map((request) => request.body.seq)).toEqual([1, 2, 3]);
    const streams = new Set(fake.requests.map((request) => request.body.stream));
    expect(streams.size).toBe(1);
    const [stream] = streams;
    expect(stream).toMatch(/^[0-9a-f-]{36}$/);
    // The stream lives on the batch only, never on an event.
    expect(JSON.stringify(fake.events())).not.toContain(stream);

    // Another instance (another page load) starts its own stream at 1.
    const other = fakeHost();
    const second = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      other.host,
    );
    second.track("next_page");
    await second.flush();
    expect(other.requests[0]?.body.seq).toBe(1);
    expect(other.requests[0]?.body.stream).not.toBe(stream);
  });

  test("a retry resends the same batch with the same seq, even if events arrived meanwhile", async () => {
    spyOn(Math, "random").mockReturnValue(0);
    const fake = fakeHost();
    fake.responses.push(503);
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    mira.track("a");
    mira.track("b");
    await mira.flush();
    mira.track("c");
    await mira.flush();

    const batches = fake.requests.map((request) => ({
      seq: request.body.seq,
      events: request.body.events.map((event) => event.event),
    }));
    expect(batches).toEqual([
      { seq: 1, events: ["a", "b"] },
      { seq: 1, events: ["a", "b"] },
      { seq: 2, events: ["c"] },
    ]);
  });

  test("a batch dropped for good keeps its number used", async () => {
    const fake = fakeHost();
    fake.responses.push(400);
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    mira.track("lost");
    await mira.flush();
    mira.track("kept");
    await mira.flush();
    expect(fake.requests.map((request) => request.body.seq)).toEqual([1, 2]);
  });

  test("beacons take the next numbers, and a pending retry goes first with its own", async () => {
    spyOn(Math, "random").mockReturnValue(0);
    const fake = fakeHost();
    fake.responses.push(503);
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    mira.track("failed");
    await mira.flush();
    mira.track("waiting");
    fake.host.dispatchEvent(new Event("pagehide"));

    const stream = fake.requests[0]?.body.stream;
    expect(
      fake.beacons.map((beacon) => ({
        stream: beacon.body.stream,
        seq: beacon.body.seq,
        events: beacon.body.events.map((event) => event.event),
      })),
    ).toEqual([
      { stream, seq: 1, events: ["failed"] },
      { stream, seq: 2, events: ["waiting"] },
    ]);
    // Nothing is left to send twice.
    await mira.flush();
    expect(fake.requests).toHaveLength(1);
  });

  test("a refused beacon uses no number", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    fake.refuseBeacons = true;
    mira.track("refused");
    fake.host.dispatchEvent(new Event("pagehide"));
    expect(fake.beacons).toHaveLength(0);
    await mira.flush();
    expect(fake.requests.map((request) => request.body.seq)).toEqual([1]);
  });

  test("never throws into the host page", () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => mira.track("ok", circular)).not.toThrow();
    expect(() => mira.track(undefined as unknown as string)).not.toThrow();
    expect(() => mira.track("$pageview")).not.toThrow();
    expect(() => mira.consent(null as never)).not.toThrow();
  });
});

describe("autocapture", () => {
  test("SPA navigations send one pageview per page with the previous URL as referrer", async () => {
    const fake = fakeHost();
    const mira = createMira({ ...base, consent: { analytics: false } }, fake.host);
    fake.navigate("/pricing");
    fake.host.history.replaceState(null, "", "/pricing"); // same URL: no second pageview
    await tick(150);
    fake.navigate("/pricing#faq"); // hash change on a normal site: same page
    await tick(150);
    await mira.flush();

    const pages = fake.events().filter((event) => event.event === "$pageview");
    expect(pages.map((event) => event.context.page.url)).toEqual([
      "https://shop.example/landing?utm_source=news",
      "https://shop.example/pricing",
    ]);
    expect(pages[0]?.context.page.referrer).toBe("https://www.google.com/");
    expect(pages[1]?.context.page.referrer).toBe("https://shop.example/landing?utm_source=news");
  });

  test("a prerendered page sends nothing until it is shown", async () => {
    const fake = fakeHost();
    (fake.host.document as unknown as { prerendering: boolean }).prerendering = true;
    const mira = createMira({ ...base, consent: { analytics: false } }, fake.host);
    await mira.flush();
    expect(fake.requests).toHaveLength(0);

    (fake.host.document as unknown as { prerendering: boolean }).prerendering = false;
    fake.host.document.dispatchEvent(new Event("prerenderingchange"));
    await mira.flush();
    expect(fake.events().map((event) => event.event)).toEqual(["$pageview"]);
  });

  test("calls before init are replayed", async () => {
    const fake = fakeHost();
    const mira = createMira(undefined, fake.host);
    mira.track("early");
    mira.init({ ...base, consent: { analytics: false }, autocapture: false });
    await mira.flush();
    expect(fake.events().map((event) => event.event)).toEqual(["early"]);
  });
});

describe("2.0 additions", () => {
  test("a secret key never starts the SDK and is reported even without debug", async () => {
    const fake = fakeHost();
    const error = spyOn(console, "error").mockImplementation(() => {});
    const mira = createMira({ ...base, key: "mira_sk_live_leaked" }, fake.host);
    mira.track("anything");
    await mira.flush();
    expect(fake.events()).toHaveLength(0);
    expect(String(error.mock.calls[0]?.[0])).toContain("secret key");
    error.mockRestore();
  });

  test("survey sends a $touchpoint of kind survey, also at T0", async () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    mira.survey({
      source: " podcast ",
      answer: "The Elternzeit podcast",
      channel: "nope" as never,
    });
    mira.survey({ answer: "no source" });
    await mira.flush();
    const events = fake.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "track",
      event: "$touchpoint",
      properties: { kind: "survey", source: "podcast", answer: "The Elternzeit podcast" },
    });
    expect(events[0]?.properties.channel).toBeUndefined();
  });

  test("anonymousId is there only with analytics consent", () => {
    const fake = fakeHost();
    const mira = createMira(
      { ...base, consent: { analytics: false }, autocapture: false },
      fake.host,
    );
    expect(mira.anonymousId).toBeUndefined();
    mira.consent({ analytics: true });
    expect(mira.anonymousId).toMatch(/^[0-9a-f-]{36}$/);
    mira.consent({ analytics: false });
    expect(mira.anonymousId).toBeUndefined();
  });

  test("an event map types names and properties", () => {
    const fake = fakeHost();
    const mira = createMira<{ signup_started: { plan: "free" | "pro" } }>(
      { ...base, autocapture: false },
      fake.host,
    );
    mira.track("signup_started", { plan: "pro" });
    // @ts-expect-error: not in the event map
    mira.track("unknown_event");
    // @ts-expect-error: wrong property value
    mira.track("signup_started", { plan: "enterprise" });
  });
});
