/**
 * A plain fake window for tests: just enough DOM for the SDK, and a storage that records every
 * access, so a test can prove that T0 never touches the device.
 */
import type { Host } from "../consent/types";

export interface SentRequest {
  url: string;
  body: {
    key?: string;
    sent_at?: string;
    stream?: string;
    seq?: number;
    events: Record<string, any>[];
  };
  keepalive?: boolean;
}

export class RecordingStorage implements Storage {
  readonly data = new Map<string, string>();
  accesses = 0;
  get length() {
    this.accesses += 1;
    return this.data.size;
  }
  clear() {
    this.accesses += 1;
    this.data.clear();
  }
  getItem(key: string) {
    this.accesses += 1;
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    this.accesses += 1;
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.accesses += 1;
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.accesses += 1;
    this.data.set(key, value);
  }
}

export interface FakeHost {
  host: Host;
  storage: RecordingStorage;
  /** How often anything read `window.localStorage`, `sessionStorage` or `document.cookie`. */
  storageReads: () => number;
  requests: SentRequest[];
  beacons: SentRequest[];
  /** How often the SDK asked for high-entropy client hints. */
  hintCalls: () => number;
  /** When true, `sendBeacon` refuses like a browser with a full beacon quota. */
  refuseBeacons: boolean;
  /** Status codes the fake ingest answers with, in order; then 202. */
  responses: (number | "network")[];
  navigate(url: string): void;
  /** Dispatches an event on the document as if it had bubbled up from `target`. */
  dispatch(type: string, target: unknown, init?: Record<string, unknown>): void;
  events(): Record<string, any>[];
}

/**
 * A minimal element for delegated listeners: links match `closest("a[href]…")`, other elements
 * ask their parent. `reads` lists every property the SDK touched, so a test can prove that form
 * fields are never read.
 */
export function fakeElement(
  attributes: Record<string, string>,
  parent?: { closest(selector: string): unknown },
) {
  const reads: string[] = [];
  const element = new Proxy(
    {
      getAttribute: (name: string) => attributes[name] ?? null,
      hasAttribute: (name: string) => name in attributes,
      closest: (selector: string): unknown =>
        selector.includes("[href]") && "href" in attributes
          ? element
          : (parent?.closest(selector) ?? null),
    },
    {
      get(target, property, receiver) {
        reads.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    },
  );
  return { element, reads };
}

/** Like `Object.assign`, but keeps getters as getters (so storage reads stay countable). */
const extend = <T extends object, U extends object>(target: T, source: U): T & U =>
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)) as T & U;

export function fakeHost(
  options: { url?: string; referrer?: string; extra?: Record<string, unknown> } = {},
): FakeHost {
  const storage = new RecordingStorage();
  let reads = 0;
  const requests: SentRequest[] = [];
  const beacons: SentRequest[] = [];
  const responses: (number | "network")[] = [];
  let hintCalls = 0;
  const location = { href: options.url ?? "https://shop.example/landing?utm_source=news" };

  const document = extend(new EventTarget(), {
    title: "Landing",
    referrer: options.referrer ?? "https://www.google.com/",
    visibilityState: "visible",
    readyState: "complete",
    documentElement: { scrollHeight: 2880 },
    prerendering: false,
    querySelector: () => null,
    get cookie() {
      reads += 1;
      return "";
    },
  });

  const history = {
    pushState(_state: unknown, _title: string, url?: string) {
      if (url) location.href = new URL(url, location.href).href;
    },
    replaceState(_state: unknown, _title: string, url?: string) {
      if (url) location.href = new URL(url, location.href).href;
    },
  };

  const fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(init.body as string), keepalive: init.keepalive });
    const next = responses.shift() ?? 202;
    if (next === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }), {
      status: next,
    });
  };

  const host = extend(new EventTarget(), {
    location,
    document,
    history,
    screen: { width: 1440, height: 900 },
    devicePixelRatio: 2,
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 720,
    navigator: {
      language: "de-DE",
      languages: ["de-DE", "de", "en"],
      userAgentData: {
        getHighEntropyValues: async () => {
          hintCalls += 1;
          return { model: "Pixel 9", platformVersion: "15.0.0" };
        },
      },
      sendBeacon: (url: string, body: string) => {
        if (fake.refuseBeacons) return false;
        beacons.push({ url, body: JSON.parse(body) });
        return true;
      },
    },
    fetch,
    get localStorage() {
      reads += 1;
      return storage;
    },
    get sessionStorage() {
      reads += 1;
      return storage;
    },
    ...options.extra,
  }) as unknown as Host;

  const fake: FakeHost = {
    host,
    storage,
    storageReads: () => reads + storage.accesses,
    requests,
    beacons,
    responses,
    navigate(url) {
      host.history.pushState(null, "", url);
    },
    dispatch(type, target, init = {}) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "target", { value: target });
      for (const [name, value] of Object.entries(init)) {
        Object.defineProperty(event, name, { value });
      }
      host.document.dispatchEvent(event);
    },
    refuseBeacons: false,
    hintCalls: () => hintCalls,
    events: () => requests.flatMap((request) => request.body.events),
  };
  return fake;
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
