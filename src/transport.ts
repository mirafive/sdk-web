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
export class Transport {
  private queue: QueuedEvent[] = [];
  /** The batch in flight, or the failed one waiting for its retry. */
  private held: Batch | undefined;
  private inFlight = false;
  /** Random per SDK instance (one page load), memory only: never stored, never on an event. */
  private readonly stream = uuidv7();
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private retryAt = 0;
  private running: Promise<void> | undefined;
  /** Held while the page is prerendered: nothing leaves before the person actually sees it. */
  paused = false;

  private readonly options: TransportOptions;

  constructor(options: TransportOptions) {
    this.options = options;
  }

  get size() {
    return this.queue.length + (this.held?.events.length ?? 0);
  }

  enqueue(event: QueuedEvent) {
    this.queue.push(event);
    if (this.queue.length > LIMITS.maxQueue)
      this.queue.splice(0, this.queue.length - LIMITS.maxQueue);
    this.changed();
    this.schedule(this.queue.length >= LIMITS.batchSize ? 0 : LIMITS.batchDelayMs);
  }

  /** Adds events restored from storage, skipping any that are already queued. */
  restore(events: QueuedEvent[]) {
    const known = new Set(this.pending().map((event) => event.event_id));
    const fresh = events.filter((event) => event?.event_id && !known.has(event.event_id));
    if (!fresh.length) return;
    this.queue.unshift(...fresh);
    this.schedule(LIMITS.batchDelayMs);
  }

  /** Sends everything now (respecting a pending backoff). Resolves when the queue is empty or a send failed. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running ??= this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * Last chance on page hide: hand the queue to `sendBeacon`, which survives the page. The beacon
   * goes to `/v1/p` as `text/plain`, a "simple" request without a CORS preflight.
   */
  beacon() {
    if (this.paused || !this.options.beacon) return;
    this.dropExpired();
    // A failed batch waiting for its retry goes first, with its own number. A batch in flight is
    // left to its keepalive fetch.
    if (this.held && !this.inFlight) {
      if (!this.sendBeacon(this.held)) return this.changed();
      this.held = undefined;
    }
    while (this.queue.length) {
      const batch = { seq: this.seq + 1, events: this.queue.slice(0, LIMITS.batchSize) };
      // The browser refused (quota full): keep the rest for the persisted queue and the next page.
      // The number is only used once the beacon is accepted, so a refusal leaves no gap.
      if (!this.sendBeacon(batch)) break;
      this.seq = batch.seq;
      this.queue.splice(0, batch.events.length);
    }
    this.changed();
  }

  /** Forgets every queued event (used by tests and on hard reset). */
  clear() {
    this.queue = [];
    this.held = undefined;
    this.changed();
  }

  resume() {
    this.paused = false;
    if (this.size) this.schedule(0);
  }

  private schedule(delay: number) {
    if (this.paused) return;
    const at = Math.max(Date.now() + delay, this.retryAt);
    if (this.timer !== undefined) {
      // Never postpone an earlier send; only bring a later one forward (when the batch filled up).
      if (delay > 0) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, at - Date.now());
  }

  private async drain() {
    while ((this.held || this.queue.length) && !this.paused) {
      if (Date.now() < this.retryAt) {
        this.schedule(0);
        return;
      }
      if (!this.held) {
        this.dropExpired();
        if (!this.queue.length) return;
        this.held = { seq: (this.seq += 1), events: this.queue.splice(0, LIMITS.batchSize) };
      }
      const batch = this.held;
      this.inFlight = true;
      // One request at a time, on purpose: order is kept and a failing ingest is not hammered.
      // oxlint-disable-next-line no-await-in-loop
      const outcome = await this.send(batch);
      this.inFlight = false;
      if (outcome === "retry") {
        this.changed();
        this.schedule(0);
        return;
      }
      // Sent, or dropped for good. A beacon on page hide may have taken it meanwhile.
      if (this.held === batch) this.held = undefined;
      this.changed();
    }
  }

  private async send(batch: Batch): Promise<Outcome> {
    const body = this.body(batch);
    try {
      const response = await this.options.fetch(`${this.options.host}/v1/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        // `keepalive` lets the request finish when the page navigates away mid-send.
        keepalive: body.length <= LIMITS.keepaliveBytes,
        credentials: "omit",
        signal: AbortSignal.timeout?.(LIMITS.requestTimeoutMs),
      });
      if (response.ok) {
        this.failures = 0;
        this.retryAt = 0;
        return "sent";
      }
      if (response.status === 429 || response.status === 408 || response.status >= 500) {
        return this.backoff(Number(response.headers.get("retry-after")) * 1000 || 0);
      }
      this.options.onError?.(`batch dropped (${response.status})`);
      return "drop";
    } catch {
      return this.backoff(0);
    }
  }

  /** Exponential backoff with full jitter, at least what the server asked for in `retry-after`. */
  private backoff(minimumMs: number): Outcome {
    this.failures += 1;
    const ceiling = Math.min(LIMITS.maxBackoffMs, 1000 * 2 ** this.failures);
    this.retryAt = Date.now() + Math.max(minimumMs, Math.random() * ceiling);
    return "retry";
  }

  /** Hands one batch to `sendBeacon`; false when it is too large or the browser refused it. */
  private sendBeacon(batch: Batch): boolean {
    const body = this.body(batch);
    if (body.length > LIMITS.keepaliveBytes) return false;
    try {
      return this.options.beacon?.(`${this.options.host}/v1/p`, body) === true;
    } catch {
      return false;
    }
  }

  private body(batch: Batch) {
    return JSON.stringify({
      key: this.options.key,
      sent_at: new Date().toISOString(),
      stream: this.stream,
      seq: batch.seq,
      events: batch.events,
    });
  }

  private dropExpired() {
    const oldest = Date.now() - LIMITS.maxAgeMs;
    const before = this.queue.length;
    this.queue = this.queue.filter((event) => Date.parse(event.timestamp) >= oldest);
    if (this.queue.length !== before) this.changed();
  }

  /** Every event not yet confirmed, in order. */
  private pending(): QueuedEvent[] {
    return [...(this.held?.events ?? []), ...this.queue];
  }

  private changed() {
    this.options.persist?.(this.pending());
  }
}
