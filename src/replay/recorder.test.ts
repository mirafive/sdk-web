/* oxlint-disable typescript/no-unsafe-type-assertion -- test fakes stand in for browser globals */
import { afterEach, describe, expect, test } from "bun:test";

import type { ReplayAnswer } from "@mirafive/protocol";

import { fakeHost, tick } from "../test/fake-host";
import { storedGzip } from "./gzip";
import { createRecorder, type Rrweb } from "./recorder";
import { recorderSlot, recorderUrl } from "./script-loader";
import type { RecorderContext } from "./session";

const SESSION = "019ac6a4-1c2b-7d3e-8f40-123456789abc";
const answerOf = (extra: Partial<ReplayAnswer> = {}): ReplayAnswer => ({
  session_id: SESSION,
  masking: "standard",
  never_record: ["/account/*"],
  sensitive: [],
  ...extra,
});

const realSetInterval = globalThis.setInterval;
let intervals: (() => void)[] = [];
afterEach(() => {
  globalThis.setInterval = realSetInterval;
});

function setup(path: string, options: { canCompress?: boolean; throws?: boolean } = {}) {
  intervals = [];
  globalThis.setInterval = ((run: () => void) => {
    intervals.push(run);
    return intervals.length;
  }) as unknown as typeof setInterval;
  const fake = fakeHost({ url: `https://shop.example${path}` });
  (fake.host.location as { pathname?: string }).pathname = path;
  const runs: { options: Record<string, any>; stopped: boolean }[] = [];
  const snapshots: number[] = [];
  const rrweb: Rrweb = {
    record(recordOptions) {
      if (options.throws) throw new Error("rrweb failed");
      const run = { options: recordOptions as Record<string, any>, stopped: false };
      runs.push(run);
      return () => {
        run.stopped = true;
      };
    },
    takeFullSnapshot: () => snapshots.push(1),
  };
  const stops: string[] = [];
  const chunks: { pages: string[]; events: any[] }[] = [];
  let seq = 0;
  const context: RecorderContext = {
    host: fake.host,
    ingest: "https://ingest.example",
    key: "mira_pk_test",
    fetch: (async (url: string, init: RequestInit) => {
      const bytes = new Uint8Array(await (init.body as Blob).arrayBuffer());
      chunks.push({
        pages: new URL(url).searchParams.getAll("page"),
        events: JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes))),
      });
      return new Response("{}", { status: 202 });
    }) as typeof fetch,
    query: () => ({ consent_analytics: "granted", consent_marketing: "denied" }),
    warn: () => {},
    answer: answerOf(),
    nextSeq: () => seq++,
    stopped: (scope) => stops.push(scope),
  };
  const handle = createRecorder(context, rrweb, {
    canCompress: options.canCompress ?? true,
    compress: async (bytes) => storedGzip(bytes),
  });
  const go = (next: string) => {
    (fake.host.location as { pathname?: string }).pathname = next;
  };
  const emit = (type: number, timestamp: number) =>
    runs.at(-1)?.options.emit({ type, data: {}, timestamp });
  return { handle, runs, stops, chunks, go, emit, snapshots, fake };
}

const flush = async () => {
  await tick(60);
  await tick();
};

describe("recording a page", () => {
  test("rrweb gets the masking options and the two plugins", () => {
    const { runs } = setup("/");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.options).toMatchObject({ maskTextSelector: "*", maskAllInputs: false });
    expect(runs[0]!.options.plugins.map((plugin: { name: string }) => plugin.name)).toEqual([
      "mira/guard@1",
      "mira/problems@1",
    ]);
  });

  test("events become chunks naming their pages", async () => {
    const { handle, emit, chunks } = setup("/");
    emit(4, 1);
    emit(2, 2);
    emit(3, 3);
    await flush();
    handle!.cut();
    await flush();
    expect(chunks.map((chunk) => chunk.events.map((event) => event.type))).toEqual([[4, 2], [3]]);
    expect(chunks.every((chunk) => chunk.pages.join() === "/")).toBe(true);
  });

  test("a browser without CompressionStream records nothing", () => {
    const { handle, runs } = setup("/", { canCompress: false });
    expect(handle).toBeUndefined();
    expect(runs).toHaveLength(0);
  });

  test("rrweb that throws stops recording for the page, and nothing reaches the page", () => {
    const { handle, stops } = setup("/", { throws: true });
    expect(handle).toBeUndefined();
    expect(stops).toEqual(["page"]);
  });
});

describe("pages that are never recorded", () => {
  test("a visit that starts on one records nothing until it leaves it", () => {
    const { runs, go } = setup("/account/orders");
    expect(runs).toHaveLength(0);
    go("/account/profile");
    intervals[0]!();
    expect(runs).toHaveLength(0);
    go("/products/shirt");
    intervals[0]!();
    expect(runs).toHaveLength(1);
  });

  test("a single-page navigation to one: nothing of it is kept, rrweb stops, and resumes after", async () => {
    const { runs, go, emit, chunks } = setup("/");
    emit(4, 1);
    emit(2, 2);
    emit(3, 3);
    go("/account/orders");
    // The account page renders: its events are dropped.
    emit(3, 4);
    emit(3, 5);
    await flush();
    expect(runs[0]!.stopped).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.events.map((event) => event.timestamp))).toEqual([
      1, 2, 3,
    ]);
    expect(chunks.flatMap((chunk) => chunk.pages)).not.toContain("/account/orders");
    // Back on a recorded page: a new full snapshot.
    go("/cart");
    intervals.at(-1)!();
    expect(runs).toHaveLength(2);
  });

  test("a later batch that adds the current page to the list pauses at once", async () => {
    const { handle, runs, emit, chunks } = setup("/members");
    emit(3, 1);
    handle!.update(answerOf({ never_record: ["/members*"] }));
    emit(3, 2);
    await flush();
    expect(runs[0]!.stopped).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.events.map((event) => event.timestamp))).toEqual([1]);
  });
});

describe("stopping", () => {
  test("withdrawn consent: rrweb stops and nothing more is sent", async () => {
    const { handle, runs, emit, chunks } = setup("/");
    emit(3, 1);
    handle!.stop(false);
    emit(3, 2);
    await flush();
    expect(runs[0]!.stopped).toBe(true);
    expect(chunks).toHaveLength(0);
  });

  test("another session: what was recorded still goes", async () => {
    const { handle, emit, chunks } = setup("/");
    emit(3, 1);
    await flush();
    handle!.stop(true);
    await flush();
    expect(chunks.flatMap((chunk) => chunk.events)).toHaveLength(1);
  });
});

describe("the recorder file beside the script", () => {
  test("every URL of a release loads that release's recorder, without query or fragment", () => {
    for (const script of [
      "https://cdn.mirafive.io/sdk/mira.js",
      "https://cdn.mirafive.io/sdk/v2/mira.js",
      "https://cdn.mirafive.io/sdk/mira@2.3.0.js?x=1#y",
    ]) {
      expect(recorderUrl(script, "2.3.0")).toBe(
        "https://cdn.mirafive.io/sdk/mira-recorder@2.3.0.js",
      );
    }
    // A first-party proxy: beside the script, wherever it is.
    expect(recorderUrl("https://shop.example/t/m.js", "2.3.0")).toBe(
      "https://shop.example/t/mira-recorder@2.3.0.js",
    );
    expect(recorderUrl("not a url", "2.3.0")).toBeUndefined();
  });

  test("each release registers under its own name", () => {
    expect(recorderSlot("2.3.0")).toBe(Symbol.for("mirafive.recorder@2.3.0"));
    expect(recorderSlot("2.3.0")).not.toBe(recorderSlot("2.3.1"));
  });
});
