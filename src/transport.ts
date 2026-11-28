import type { WireEvent } from "@mirafive/protocol";
import { uuidv7 } from "@mirafive/protocol";

/** An event as the SDK queues it: id and timestamp are always set before it enters the queue. */
export type QueuedEvent = WireEvent & { event_id: string; timestamp: string };

/** A formed batch. Once it has a number its events never change, so a retry is the same batch. */
interface Batch {
  seq: number;
  events: QueuedEvent[];
}

export interface TransportOptions {
  /** Ingest origin, for example `https://mirafive.io`. */
  host: string;
  key: string;
  fetch: typeof fetch;
  /** `navigator.sendBeacon`, bound; missing in old browsers and non-browser runtimes. */
  beacon?: (url: string, body: string) => boolean;
  /** Called after every queue change with all events not yet confirmed; the core decides whether it may store them. */
  persist?: (events: QueuedEvent[]) => void;
  /** The body of a `202`: the server's answer, with its `replay` field when it records the session. */
  onAnswer?: (body: unknown) => void;
  onError?: (message: string) => void;
}

export const LIMITS = {
  /** Events per request. The ingest takes up to 100; 50 keeps a batch well under keepalive's 64 kB. */
  batchSize: 50,
  batchDelayMs: 2_000,
  maxQueue: 1_000,
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxBackoffMs: 5 * 60 * 1000,
  requestTimeoutMs: 10_000,
  /** Browsers cap all in-flight keepalive and beacon bodies together at 64 kB. */
  keepaliveBytes: 60_000,
} as const;

type Outcome = "sent" | "drop" | "retry";

/**
 * In-memory queue with batching and retry (docs/architecture.md, SDK design).
 *
 * - A batch leaves when 50 events are waiting or 2 s after the first one.
 * - Every batch carries this instance's `stream` id and a `seq` that counts batches from 1
 *   (docs/integrity.md, Reconciliation). The ingest counts missing numbers as lost batches.
 * - Network errors, 5xx, 408 and 429 are retried with exponential backoff and full jitter. The
 *   failed batch is kept as it is and sent again with the same events and the same `seq`, so the
 *   ingest deduplicates it by `event_id` and sees no gap.
 * - Other 4xx answers (bad request, unknown key, 402 paused plan, 413) are final: retrying would
 *   only fail again, so the batch is dropped. Its number stays used: the gap is the lost batch.
 * - Queue size and event age are capped, so a site that is offline for a day cannot fill memory.
 */
export interface Transport {
  enqueue(event: QueuedEvent): void;
  /** Adds events restored from storage, skipping any that are already queued. */
  restore(events: QueuedEvent[]): void;
  /** Sends everything now (respecting a pending backoff). Resolves when the queue is empty or a send failed. */
  flush(): Promise<void>;
  /**
   * Last chance on page hide: hand the queue to `sendBeacon`, which survives the page. The beacon
   * goes to `/v1/p` as `text/plain`, a "simple" request without a CORS preflight.
   */
  beacon(): void;
  /** Holds every event while the page is prerendered: nothing leaves before the person sees it. */
  pause(): void;
  resume(): void;
  /** Events not yet confirmed. */
  readonly size: number;
}

export function createTransport(options: TransportOptions): Transport {
  let queue: QueuedEvent[] = [];
  /** The batch in flight, or the failed one waiting for its retry. */
  let held: Batch | undefined;
  let inFlight = false;
  /** Random per SDK instance (one page load), memory only: never stored, never on an event. */
  const stream = uuidv7();
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let retryAt = 0;
  let running: Promise<void> | undefined;
  let paused = false;

  /** Every event not yet confirmed, in order. */
  const pending = (): QueuedEvent[] => [...(held?.events ?? []), ...queue];
  const changed = () => options.persist?.(pending());

  const body = (batch: Batch) =>
    JSON.stringify({
      key: options.key,
      sent_at: new Date().toISOString(),
      stream,
      seq: batch.seq,
      events: batch.events,
    });

  function dropExpired() {
    const oldest = Date.now() - LIMITS.maxAgeMs;
    const before = queue.length;
    queue = queue.filter((event) => Date.parse(event.timestamp) >= oldest);
    if (queue.length !== before) changed();
  }

  function schedule(delay: number) {
    if (paused) return;
    const at = Math.max(Date.now() + delay, retryAt);
    if (timer !== undefined) {
      // Never postpone an earlier send; only bring a later one forward (when the batch filled up).
      if (delay > 0) return;
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, at - Date.now());
  }

  /** Exponential backoff with full jitter, at least what the server asked for in `retry-after`. */
  function backoff(minimumMs: number): Outcome {
    failures += 1;
    const ceiling = Math.min(LIMITS.maxBackoffMs, 1000 * 2 ** failures);
    retryAt = Date.now() + Math.max(minimumMs, Math.random() * ceiling);
    return "retry";
  }

  async function send(batch: Batch): Promise<Outcome> {
    const text = body(batch);
    try {
      const response = await options.fetch(`${options.host}/v1/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
        // `keepalive` lets the request finish when the page navigates away mid-send.
        keepalive: text.length <= LIMITS.keepaliveBytes,
        credentials: "omit",
        signal: AbortSignal.timeout?.(LIMITS.requestTimeoutMs),
      });
      if (response.ok) {
        failures = 0;
        retryAt = 0;
        if (response.status === 202 && options.onAnswer) {
          // The answer only steers recording: a body that cannot be read, or a hook that throws,
          // never turns a delivered batch into a retry.
          const answer: unknown = await response.json().catch(() => undefined);
          try {
            options.onAnswer(answer);
          } catch {
            // Swallowed: recording is never in the way of events.
          }
        }
        return "sent";
      }
      if (response.status === 429 || response.status === 408 || response.status >= 500) {
        return backoff(Number(response.headers.get("retry-after")) * 1000 || 0);
      }
      options.onError?.(`batch dropped (${response.status})`);
      return "drop";
    } catch {
      return backoff(0);
    }
  }

  /** Hands one batch to `sendBeacon`; false when it is too large or the browser refused it. */
  function sendBeacon(batch: Batch): boolean {
    const text = body(batch);
    if (text.length > LIMITS.keepaliveBytes) return false;
    try {
      return options.beacon?.(`${options.host}/v1/p`, text) === true;
    } catch {
      return false;
    }
  }

  async function drain() {
    while ((held || queue.length) && !paused) {
      if (Date.now() < retryAt) {
        schedule(0);
        return;
      }
      if (!held) {
        dropExpired();
        if (!queue.length) return;
        held = { seq: (seq += 1), events: queue.splice(0, LIMITS.batchSize) };
      }
      const batch = held;
      inFlight = true;
      // One request at a time, on purpose: order is kept and a failing ingest is not hammered.
      // oxlint-disable-next-line no-await-in-loop
      const outcome = await send(batch);
      inFlight = false;
      if (outcome === "retry") {
        changed();
        schedule(0);
        return;
      }
      // Sent, or dropped for good. A beacon on page hide may have taken it meanwhile.
      if (held === batch) held = undefined;
      changed();
    }
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    running ??= drain().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    enqueue(event) {
      queue.push(event);
      if (queue.length > LIMITS.maxQueue) queue.splice(0, queue.length - LIMITS.maxQueue);
      changed();
      schedule(queue.length >= LIMITS.batchSize ? 0 : LIMITS.batchDelayMs);
    },
    restore(events) {
      const known = new Set(pending().map((event) => event.event_id));
      const fresh = events.filter((event) => event?.event_id && !known.has(event.event_id));
      if (!fresh.length) return;
      queue.unshift(...fresh);
      schedule(LIMITS.batchDelayMs);
    },
    flush,
    beacon() {
      if (paused || !options.beacon) return;
      dropExpired();
      // A failed batch waiting for its retry goes first, with its own number. A batch in flight is
      // left to its keepalive fetch.
      if (held && !inFlight) {
        if (!sendBeacon(held)) return changed();
        held = undefined;
      }
      while (queue.length) {
        const batch = { seq: seq + 1, events: queue.slice(0, LIMITS.batchSize) };
        // The browser refused (quota full): keep the rest for the persisted queue and the next page.
        // The number is only used once the beacon is accepted, so a refusal leaves no gap.
        if (!sendBeacon(batch)) break;
        seq = batch.seq;
        queue.splice(0, batch.events.length);
      }
      changed();
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      if (pending().length) schedule(0);
    },
    get size() {
      return pending().length;
    },
  };
}
