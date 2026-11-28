/* oxlint-disable typescript/no-unsafe-type-assertion -- test fakes stand in for browser globals */
import { afterEach, describe, expect, test } from "bun:test";

import { isGzip, REPLAY_LIMITS } from "@mirafive/protocol";

import { CHUNKS, createChunker, reactionTo, retryDelay, type Reaction } from "./chunker";
import { storedGzip } from "./gzip";
import type { RecordedEvent } from "./sanitize";

const SESSION = "019ac6a4-1c2b-7d3e-8f40-123456789abc";

/** Timers under the test's control: `run` fires what is due within `ms`. */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let timers: { at: number; run: () => void; id: number }[] = [];
let clockNow = 0;
let nextId = 1;
function fakeTimers() {
  timers = [];
  clockNow = 0;
  globalThis.setTimeout = ((run: () => void, ms = 0) => {
    const id = nextId++;
    timers.push({ at: clockNow + ms, run, id });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers = timers.filter((timer) => timer.id !== id);
  }) as typeof clearTimeout;
}
async function advance(ms: number) {
  clockNow += ms;
  for (;;) {
    const due = timers.filter((timer) => timer.at <= clockNow).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((timer) => timer !== due);
    due.run();
    await settle();
  }
  await settle();
}
/** Lets promise chains (compress, fetch, the pump) run. */
const settle = async () => {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
};

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

interface Sent {
  url: URL;
  body: Uint8Array<ArrayBuffer>;
  type: string;
  init: RequestInit;
}

function setup(answers: (number | "network" | "hang" | [number, Record<string, string>])[] = []) {
  fakeTimers();
  const sent: Sent[] = [];
  const beacons: Sent[] = [];
  const log: string[] = [];
  let seq = 0;
  let refuseBeacons = false;
  let compressed = (bytes: Uint8Array<ArrayBuffer>) => storedGzip(bytes);
  const chunker = createChunker({
    ingest: "https://ingest.example",
    key: "mira_pk_test",
    session: SESSION,
    tab: "Xk2_9-pQr7Ta",
    fetch: (async (url: string, init: RequestInit) => {
      const blob = init.body as Blob;
      sent.push({
        url: new URL(url),
        body: new Uint8Array(await blob.arrayBuffer()),
        type: blob.type,
        init,
      });
      const next = answers.shift() ?? 202;
      if (next === "network") throw new TypeError("Failed to fetch");
      if (next === "hang") return new Promise<Response>(() => {});
      const [status, headers] = Array.isArray(next) ? next : [next, {}];
      return new Response("{}", { status, headers });
    }) as typeof fetch,
    beacon: (url, body) => {
      if (refuseBeacons) return false;
      void body.arrayBuffer().then((buffer) =>
        beacons.push({
          url: new URL(url),
          body: new Uint8Array(buffer),
          type: body.type,
          init: {},
        }),
      );
      return true;
    },
    nextSeq: () => seq++,
    query: () => ({
      consent_analytics: "granted",
      consent_marketing: "denied",
      anonymous_id: "anon-1",
    }),
    compress: async (bytes) => compressed(bytes),
    now: () => 1_000_000 + clockNow,
    idle: (work) => work(),
    takeFullSnapshot: () => log.push("snapshot"),
    stop: (scope) => log.push(`stop ${scope}`),
    count: (what) => log.push(what),
  });
  return {
    chunker,
    sent,
    beacons,
    log,
    answers,
    refuse: (value: boolean) => (refuseBeacons = value),
    compressTo: (size: number) => {
      compressed = () => new Uint8Array(size);
    },
  };
}

const at = (timestamp: number) => timestamp;
const meta = (t: number): RecordedEvent => ({
  type: 4,
  data: { href: "https://shop.example/" },
  timestamp: at(t),
});
const full = (t: number, size = 10): RecordedEvent => ({
  type: 2,
  data: { node: "x".repeat(size) },
  timestamp: at(t),
});
const change = (t: number, size = 10): RecordedEvent => ({
  type: 3,
  data: { source: 0, texts: ["x".repeat(size)] },
  timestamp: at(t),
});
const eventsOf = (body: Uint8Array<ArrayBuffer>) =>
  JSON.parse(new TextDecoder().decode(Bun.gunzipSync(body))) as RecordedEvent[];

describe("cutting", () => {
  test("a page's full snapshot is its own chunk, sent at once", async () => {
    const { chunker, sent } = setup();
    chunker.add(meta(100), "/");
    chunker.add(full(101), "/");
    chunker.add(change(102), "/");
    await settle();
    expect(sent).toHaveLength(1);
    expect(eventsOf(sent[0]!.body).map((event) => event.type)).toEqual([4, 2]);
    expect(chunker.state.pending).toBe(1);
  });

  test("changes are cut every 30 seconds", async () => {
    const { chunker, sent } = setup();
    chunker.add(change(100), "/");
    chunker.add(change(200), "/");
    await advance(CHUNKS.everyMs - 1);
    expect(sent).toHaveLength(0);
    await advance(1);
    expect(sent).toHaveLength(1);
    expect(eventsOf(sent[0]!.body)).toHaveLength(2);
  });

  test("or at 256 KB of text", async () => {
    const { chunker, sent } = setup();
    for (let index = 0; index < 5; index += 1) chunker.add(change(index, 60 * 1024), "/");
    await settle();
    expect(sent).toHaveLength(1);
    expect(eventsOf(sent[0]!.body)).toHaveLength(5);
  });

  test("events before a new page picture go first, in their own chunk", async () => {
    const { chunker, sent } = setup();
    chunker.add(change(100), "/a");
    chunker.add(meta(200), "/b");
    chunker.add(full(201), "/b");
    await settle();
    expect(sent.map((request) => request.url.searchParams.getAll("page"))).toEqual([
      ["/a"],
      ["/b"],
    ]);
    expect(sent.map((request) => request.url.searchParams.get("seq"))).toEqual(["0", "1"]);
  });

  test("a chunk names at most 20 pages", async () => {
    const { chunker, sent } = setup();
    for (let index = 0; index < 21; index += 1) chunker.add(change(index), `/p/${index}`);
    chunker.cut();
    await advance(0);
    expect(sent.map((request) => request.url.searchParams.getAll("page").length)).toEqual([20, 1]);
  });

  test("the request: everything in the URL, a gzip body without a type, no credentials", async () => {
    const { chunker, sent } = setup();
    chunker.add(change(100), "/a");
    chunker.add(change(150), "/b");
    chunker.cut();
    await settle();
    const [request] = sent;
    expect(request!.url.pathname).toBe("/v1/replay");
    expect(Object.fromEntries(request!.url.searchParams)).toMatchObject({
      key: "mira_pk_test",
      session: SESSION,
      tab: "Xk2_9-pQr7Ta",
      seq: "0",
      start: "100",
      end: "150",
      sent: "1000000",
      consent_analytics: "granted",
      consent_marketing: "denied",
      anonymous_id: "anon-1",
    });
    expect(request!.url.searchParams.getAll("page")).toEqual(["/a", "/b"]);
    expect(isGzip(request!.body)).toBe(true);
    // A Blob without a type: no Content-Type header, so a simple request without a preflight.
    expect(request!.type).toBe("");
    expect(request!.init.credentials).toBe("omit");
    expect(request!.init.headers).toBeUndefined();
  });

  test("chunks go one at a time, in order, with a number each", async () => {
    const { chunker, sent } = setup();
    for (let index = 0; index < 3; index += 1) {
      chunker.add(change(index), "/");
      chunker.cut();
    }
    await settle();
    expect(sent.map((request) => request.url.searchParams.get("seq"))).toEqual(["0", "1", "2"]);
  });
});

describe("the answers to a chunk", () => {
  const rows: [number | "network", boolean, Reaction][] = [
    [202, false, "next"],
    [400, false, "snapshot"],
    [401, false, "stop-page"],
    [402, false, "stop-page"],
    [403, false, "stop-page"],
    [409, false, "stop-session"],
    [413, false, "smaller"],
    [429, false, "retry"],
    [429, true, "stop-page"],
    [503, false, "retry"],
    [503, true, "stop-page"],
    ["network", false, "retry"],
    ["network", true, "stop-page"],
    [404, false, "stop-page"],
    [500, false, "stop-page"],
  ];
  test.each(rows)("%p (retried: %p) → %s", (status, retried, reaction) => {
    expect(reactionTo(status, retried)).toBe(reaction);
  });

  test("Retry-After in seconds, within a minute; 5 seconds without one", () => {
    expect(retryDelay("2")).toBe(2_000);
    expect(retryDelay("3600")).toBe(60_000);
    expect(retryDelay(null)).toBe(5_000);
    expect(retryDelay("soon")).toBe(5_000);
  });

  const send = async (answers: Parameters<typeof setup>[0]) => {
    const context = setup(answers);
    context.chunker.add(change(100), "/");
    context.chunker.cut();
    await settle();
    return context;
  };

  test("202: stored, the next chunk takes the next number", async () => {
    const { chunker, sent, log } = await send([202]);
    chunker.add(change(200), "/");
    chunker.cut();
    await settle();
    expect(sent.map((request) => request.url.searchParams.get("seq"))).toEqual(["0", "1"]);
    expect(log).toEqual([]);
  });

  test("400: the chunk is dropped and a new full snapshot taken; recording goes on", async () => {
    const { chunker, log } = await send([400]);
    expect(log).toEqual(["dropped", "snapshot"]);
    expect(chunker.state.done).toBe(false);
  });

  test.each([401, 402, 403])("%i: recording stops for the page", async (status) => {
    const { chunker, log } = await send([status]);
    expect(log).toEqual(["stop page"]);
    expect(chunker.state.done).toBe(true);
  });

  test("409: recording stops for the session, and what is buffered is dropped", async () => {
    const context = setup([409]);
    context.chunker.add(change(100), "/");
    context.chunker.cut();
    context.chunker.add(change(200), "/");
    await settle();
    expect(context.log).toEqual(["stop session"]);
    expect(context.chunker.state).toMatchObject({ done: true, pending: 0, queued: 0 });
  });

  test("413: dropped, a new full snapshot, and smaller chunks from now on", async () => {
    const { chunker, log } = await send([413]);
    expect(log).toEqual(["dropped", "snapshot"]);
    expect(chunker.state.maxBytes).toBe(CHUNKS.maxBytes / 2);
  });

  test("413 on a page's full snapshot: that page cannot be recorded", async () => {
    const context = setup([413]);
    context.chunker.add(meta(100), "/");
    context.chunker.add(full(101), "/");
    await settle();
    expect(context.log).toEqual(["dropped", "stop page"]);
  });

  test("a chunk that is over the limit after gzip is not sent, and counts as a 413", async () => {
    const context = setup();
    context.compressTo(REPLAY_LIMITS.chunkBytes + 1);
    context.chunker.add(change(100), "/");
    context.chunker.cut();
    await settle();
    expect(context.sent).toHaveLength(0);
    expect(context.log).toEqual(["dropped", "snapshot"]);
  });

  test.each([429, 503])(
    "%i: the same chunk once more after Retry-After, then it is stored",
    async (status) => {
      const { sent, log } = await send([[status, { "retry-after": "2" }], 202]);
      expect(sent).toHaveLength(1);
      await advance(1_999);
      expect(sent).toHaveLength(1);
      await advance(1);
      expect(sent.map((request) => request.url.searchParams.get("seq"))).toEqual(["0", "0"]);
      expect(log).toEqual([]);
    },
  );

  test.each([429, 503])("%i twice: recording stops for the page", async (status) => {
    const { sent, log } = await send([status, status]);
    await advance(CHUNKS.retryMs);
    expect(sent).toHaveLength(2);
    expect(log).toEqual(["stop page"]);
  });

  test("no answer at all is treated like a 503", async () => {
    const { sent, log } = await send(["network", "network"]);
    await advance(CHUNKS.retryMs);
    expect(sent).toHaveLength(2);
    expect(log).toEqual(["stop page"]);
  });

  test("slow uploads drop the page's recording, nothing else", async () => {
    const context = setup(["hang"]);
    for (let index = 0; index <= CHUNKS.maxQueued; index += 1) {
      context.chunker.add(change(index), "/");
      context.chunker.cut();
    }
    await settle();
    // The first is still in flight, the rest wait; one too many gives up.
    expect(context.log).toEqual(["stop page"]);
    expect(context.chunker.state.done).toBe(true);
  });
});

describe("page hide", () => {
  test("the rest goes as stored gzip in a beacon", async () => {
    const { chunker, beacons, sent } = setup();
    chunker.add(change(100), "/cart");
    chunker.hide();
    await settle();
    expect(sent).toHaveLength(0);
    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.url.searchParams.getAll("page")).toEqual(["/cart"]);
    expect(beacons[0]!.type).toBe("");
    expect(eventsOf(beacons[0]!.body)).toHaveLength(1);
  });

  test("what does not fit a beacon stays queued for when the page is shown again", async () => {
    const context = setup();
    context.chunker.add(change(100, CHUNKS.beaconBytes), "/");
    context.chunker.hide();
    await settle();
    expect(context.beacons).toHaveLength(0);
    // It goes with `fetch` instead, in case the page lives on.
    expect(context.sent).toHaveLength(1);
  });

  test("a refused beacon keeps the chunk", async () => {
    const context = setup();
    context.refuse(true);
    context.chunker.add(change(100), "/");
    context.chunker.hide();
    await settle();
    expect(context.beacons).toHaveLength(0);
    expect(context.sent).toHaveLength(1);
  });

  test("a chunk being compressed when the page hides leaves once, in the beacon", async () => {
    const context = setup();
    context.chunker.add(change(100), "/");
    context.chunker.cut();
    context.chunker.hide();
    await settle();
    expect(context.beacons).toHaveLength(1);
    expect(context.sent).toHaveLength(0);
  });
});

describe("stopping", () => {
  test("withdrawn consent drops everything, also what is waiting", async () => {
    const context = setup();
    context.chunker.add(change(100), "/");
    context.chunker.stop(false);
    await advance(CHUNKS.everyMs);
    expect(context.sent).toHaveLength(0);
    context.chunker.add(change(200), "/");
    expect(context.chunker.state).toMatchObject({ done: true, raw: 0, pending: 0 });
  });

  test("another session: what is buffered still goes, nothing new is taken", async () => {
    const context = setup();
    context.chunker.add(change(100), "/");
    context.chunker.stop(true);
    context.chunker.add(change(200), "/");
    await settle();
    expect(context.sent).toHaveLength(1);
    expect(eventsOf(context.sent[0]!.body)).toHaveLength(1);
  });
});
