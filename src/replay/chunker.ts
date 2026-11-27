/**
 * Cuts the recording into chunks and sends them (docs/replay.md, Wire): a page's full snapshot as
 * its own chunk at once, then a chunk every 30 seconds or at 256 KB, one request at a time and in
 * order, as CORS simple requests (the metadata in the URL, a gzip body without a type). On page
 * hide only what fits a beacon. The server's answers are handled as `reactionTo` says.
 */
import { REPLAY_LIMITS, replayChunkUrl, type ChunkQuery } from "@mirafive/protocol";

import type { RecorderContext } from "./session";
import { storedGzip } from "./gzip";
import { EVENT, type RecordedEvent } from "./sanitize";

export const CHUNKS = {
  /** A chunk of changes is cut after this long. */
  everyMs: 30_000,
  /** Or when its text reaches this size (before gzip). */
  maxBytes: 256 * 1024,
  /** A `413` halves the size, down to this. */
  minBytes: 32 * 1024,
  /** What a beacon may carry on page hide, with room for the gzip frame and other beacons. */
  beaconBytes: REPLAY_LIMITS.beaconBytes - 4 * 1024,
  /** Chunks waiting to be sent: more means the uploads are too slow, and the page's recording is dropped. */
  maxQueued: 8,
  /** One request may take this long; then it counts as failed. */
  timeoutMs: 30_000,
  /** The wait before the one repeat after a `429`, `503` or network failure without `Retry-After`. */
  retryMs: 5_000,
  maxRetryMs: 60_000,
} as const;

/** What the recorder does on an answer to a chunk (docs/replay.md, Wire, 3). */
export type Reaction =
  /** Stored: go on with the next number. */
  | "next"
  /** `400`: drop the chunk, take a new full snapshot, go on. */
  | "snapshot"
  /** `413`: drop the chunk, take a new full snapshot, cut smaller chunks. */
  | "smaller"
  /** `429`, `503`, no answer: send the same chunk once more after `Retry-After`. */
  | "retry"
  /** `401`, `402`, `403`, a second refusal, anything unknown: stop recording this page. */
  | "stop-page"
  /** `409`: stop recording the session, drop what is buffered and the tab's entry. */
  | "stop-session";

export function reactionTo(status: number | "network", retried: boolean): Reaction {
  if (status === "network" || status === 429 || status === 503) {
    return retried ? "stop-page" : "retry";
  }
  if (status >= 200 && status < 300) return "next";
  if (status === 400) return "snapshot";
  if (status === 409) return "stop-session";
  if (status === 413) return "smaller";
  return "stop-page";
}

/** Seconds of `Retry-After` as milliseconds, within reason. */
export const retryDelay = (header: string | null | undefined) => {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, CHUNKS.maxRetryMs)
    : CHUNKS.retryMs;
};

export interface Chunk {
  seq: number;
  start: number;
  end: number;
  pages: string[];
  /** The JSON array of the chunk's events. */
  body: string;
  /** Whether it holds a full snapshot (a page's first picture). */
  snapshot: boolean;
  query: ReturnType<RecorderContext["query"]>;
  /** Its request has left (a `fetch`): a page hide leaves it to that request. */
  dispatched?: boolean;
  /** It left in a beacon on page hide: the queue no longer sends it. */
  beaconed?: boolean;
}

export interface ChunkerDeps extends Pick<
  RecorderContext,
  "ingest" | "key" | "fetch" | "beacon" | "nextSeq" | "query"
> {
  compress(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
  now(): number;
  /** Runs work when the browser is idle (or soon). */
  idle(work: () => void): void;
  takeFullSnapshot(): void;
  /** The chunker gave up: the recorder stops for the page or the session. */
  stop(scope: "page" | "session"): void;
  /** Counts what went wrong without ever throwing into the page. */
  count(what: "dropped" | "failed"): void;
}

interface Pending {
  json: string;
  at: number;
  path: string;
}

const encoder = new TextEncoder();

/** The URL of one chunk. */
export function chunkUrl(
  deps: { ingest: string; key: string; session: string },
  chunk: Chunk,
  sent: number,
) {
  const query: ChunkQuery = {
    key: deps.key,
    session: deps.session,
    seq: chunk.seq,
    start: chunk.start,
    end: chunk.end,
    sent,
    page: chunk.pages,
    ...chunk.query,
  };
  return replayChunkUrl(deps.ingest, query);
}

export function createChunker(deps: ChunkerDeps & { session: string }) {
  let raw: { event: RecordedEvent; path: string }[] = [];
  let pending: Pending[] = [];
  let bytes = 0;
  let maxBytes: number = CHUNKS.maxBytes;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Chunk[] = [];
  let inFlight: { chunk: Chunk; abort: AbortController } | undefined;
  let scheduled = false;
  /** Stopped: nothing is taken or sent any more. */
  let done = false;
  /** Stopping with what is queued: nothing new is taken, the queue still goes. */
  let closing = false;

  const url = (chunk: Chunk) => chunkUrl(deps, chunk, deps.now());

  function cut(snapshot = false, send = true) {
    clearTimeout(timer);
    timer = undefined;
    if (!pending.length) return;
    const pages = [...new Set(pending.map((item) => item.path))];
    const chunk: Chunk = {
      seq: deps.nextSeq(),
      start: pending[0]!.at,
      end: pending.at(-1)!.at,
      pages,
      body: `[${pending.map((item) => item.json).join(",")}]`,
      snapshot,
      query: deps.query(),
    };
    pending = [];
    bytes = 0;
    queue.push(chunk);
    if (queue.length > CHUNKS.maxQueued) return giveUp("page");
    if (send) void pump();
  }

  /** Turns the recorded events into text and cuts where a chunk ends. */
  function process() {
    scheduled = false;
    const items = raw;
    raw = [];
    for (const { event, path } of items) {
      if (done) return;
      // A new page picture starts its own chunk: what came before goes first.
      if (event.type === EVENT.meta && pending.length) cut();
      const paths = new Set(pending.map((item) => item.path));
      if (!paths.has(path) && paths.size >= REPLAY_LIMITS.pagesPerChunk) cut();
      let json: string;
      try {
        json = JSON.stringify(event);
      } catch {
        deps.count("dropped");
        continue;
      }
      pending.push({ json, at: event.timestamp, path: path.slice(0, REPLAY_LIMITS.pathLength) });
      bytes += json.length + 1;
      if (event.type === EVENT.fullSnapshot) cut(true);
      else if (bytes >= maxBytes) cut();
    }
    if (pending.length && timer === undefined) timer = setTimeout(cutNow, CHUNKS.everyMs);
  }

  function cutNow() {
    timer = undefined;
    process();
    cut();
  }

  function giveUp(scope: "page" | "session") {
    if (done) return;
    drop();
    deps.stop(scope);
  }

  function drop() {
    done = true;
    clearTimeout(timer);
    timer = undefined;
    raw = [];
    pending = [];
    queue = [];
    inFlight?.abort.abort();
    inFlight = undefined;
  }

  async function send(
    chunk: Chunk,
  ): Promise<{ status: number | "network" | "beaconed"; retryAfter?: string | null }> {
    const body = await deps.compress(encoder.encode(chunk.body));
    // The page was hidden while this was compressed, and the chunk left in a beacon.
    if (chunk.beaconed) return { status: "beaconed" };
    if (body.length > REPLAY_LIMITS.chunkBytes) return { status: 413 };
    chunk.dispatched = true;
    const abort = new AbortController();
    inFlight = { chunk, abort };
    const timeout = setTimeout(() => abort.abort(), CHUNKS.timeoutMs);
    try {
      const response = await deps.fetch(url(chunk), {
        method: "POST",
        // A Blob without a type: no Content-Type header, so no CORS preflight.
        body: new Blob([body]),
        keepalive: body.length <= CHUNKS.beaconBytes,
        credentials: "omit",
        signal: abort.signal,
      });
      return { status: response.status, retryAfter: response.headers.get("retry-after") };
    } catch {
      return { status: "network" };
    } finally {
      clearTimeout(timeout);
      if (inFlight?.chunk === chunk) inFlight = undefined;
    }
  }

  /** One chunk with its one repeat; `undefined` when it is no longer this chunker's to send. */
  async function deliver(chunk: Chunk): Promise<Reaction | undefined> {
    let retried = false;
    for (;;) {
      const answer = await send(chunk).catch(() => ({ status: "network" as const }));
      if (done || answer.status === "beaconed" || !queue.includes(chunk)) return undefined;
      const reaction = reactionTo(answer.status, retried);
      if (reaction !== "retry") return reaction;
      retried = true;
      const wait = retryDelay("retryAfter" in answer ? answer.retryAfter : null);
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (done || !queue.includes(chunk)) return undefined;
    }
  }

  /** Sends the queue in order, one request at a time. */
  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && !done) {
        const chunk = queue[0]!;
        const reaction = await deliver(chunk);
        // Stopped meanwhile, or the chunk left in a beacon: the queue goes on from its new head.
        if (!reaction || done) continue;
        if (reaction === "stop-page" || reaction === "stop-session") {
          return giveUp(reaction === "stop-page" ? "page" : "session");
        }
        queue = queue.filter((item) => item !== chunk);
        if (reaction === "next") continue;
        deps.count("dropped");
        if (reaction === "smaller") {
          // A page whose first picture alone is too large cannot be recorded.
          if (chunk.snapshot) return giveUp("page");
          maxBytes = Math.max(CHUNKS.minBytes, Math.floor(maxBytes / 2));
        }
        deps.takeFullSnapshot();
      }
    } finally {
      pumping = false;
    }
  }

  return {
    /** A recorded event of the page at `path`. Turned into text when the browser is idle. */
    add(event: RecordedEvent, path: string) {
      if (done || closing) return;
      raw.push({ event, path });
      // A page's first picture is cut at once; everything else waits for an idle moment.
      if (scheduled) return;
      scheduled = true;
      deps.idle(process);
    },
    /** Sends what is buffered now, as its own chunk. */
    cut() {
      if (done) return;
      process();
      cut();
    },
    /**
     * The page is hidden or left: the rest goes now, as stored gzip in a beacon, with every
     * waiting chunk that fits one. What does not fit stays queued for when the page is shown again.
     */
    hide() {
      if (done) return;
      process();
      cut(false, false);
      for (const chunk of queue) {
        if (chunk.dispatched) continue;
        const text = encoder.encode(chunk.body);
        if (text.length > CHUNKS.beaconBytes) continue;
        let sent = false;
        try {
          const body = new Blob([storedGzip(text)]);
          sent = deps.beacon
            ? deps.beacon(url(chunk), body)
            : (void deps
                .fetch(url(chunk), { method: "POST", body, keepalive: true, credentials: "omit" })
                .catch(() => {}),
              true);
        } catch {
          sent = false;
        }
        if (sent) chunk.beaconed = true;
      }
      queue = queue.filter((chunk) => !chunk.beaconed);
      // What did not fit goes on with `fetch`, if the page lives on (a hidden tab).
      void pump();
    },
    /** Stops: `keep` sends what is buffered (and what is queued), else everything is dropped. */
    stop(keep: boolean) {
      if (done) return;
      if (!keep) return drop();
      process();
      cut();
      // What is queued still goes; nothing new is taken.
      closing = true;
      clearTimeout(timer);
      timer = undefined;
    },
    /** For tests: what is queued and waiting. */
    get state() {
      return { queued: queue.length, pending: pending.length, raw: raw.length, maxBytes, done };
    },
  };
}

export type Chunker = ReturnType<typeof createChunker>;
