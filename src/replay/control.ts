/**
 * Session recording, the part in the base script: as small as it can be. It watches for the
 * server's decision (the `replay` field of a batch's `202`) or the tab's record of one, and only
 * then, with analytics consent, loads the recorder file, which does everything else
 * (`session.ts`). When consent is withdrawn it stops the recorder, clears the tab's record and
 * asks the server to delete the session's recording, also when the recorder has not loaded yet.
 */
import type { ConsentState } from "@mirafive/protocol";

import type { Host } from "../consent/types";

/**
 * In `sessionStorage`: the decision, the tab's id and its next chunk number, for the tab's next
 * page; T1 only.
 */
export const REPLAY_KEY = "mira_replay";

/**
 * In `sessionStorage` while a document of the tab records, removed on `pagehide`. A browser copies
 * a tab's `sessionStorage` into a tab made from it (duplicating a tab, `window.open` and links that
 * keep the opener), so a page that finds the mark at its start was copied from a tab still open:
 * it keeps the decision but drops the tab's id and numbers (`dropTab`), and records as a tab of
 * its own. The next page of the same tab finds no mark: the page before removed it when it left.
 * A mark left behind (a crash) only makes the next page a new tab, never two tabs one.
 */
export const LIVE_KEY = "mira_replay_live";

/** A copied record: the decision stays, the tab's id and chunk numbers go. */
export function dropTab(store: Storage): void {
  const raw = store.getItem(REPLAY_KEY);
  const value: unknown = JSON.parse(raw ?? "null");
  if (typeof value !== "object" || value === null) return;
  const { tab: _tab, ...rest } = value as Record<string, unknown>;
  store.setItem(REPLAY_KEY, JSON.stringify({ ...rest, seq: 0 }));
}

/** What recording needs from the page's SDK instance. */
export interface ReplayEnvironment {
  host: Host;
  /** Ingest origin. */
  ingest: string;
  key: string;
  fetch: typeof fetch;
  beacon?: (url: string, body: Blob) => boolean;
  /** Consent and ids as a chunk carries them, at the moment it is cut. */
  query(): {
    consent_analytics: ConsentState;
    consent_marketing: ConsentState;
    anonymous_id?: string;
    user_id?: string;
  };
  warn(message: string, error?: unknown): void;
}

export interface ReplayControl {
  /** The body of a batch's `202`. */
  answer(body: unknown): void;
  /** Analytics consent is given (true) or not any more (false). */
  consent(granted: boolean): void;
  /** `reset()`: the ids are about to change. */
  reset(): void;
  /** Page hide. */
  hide(): void;
  /** `pageshow`: `persisted` when the page came back from the back-forward cache. */
  shown(persisted: boolean): void;
}

/** The recorder file's side: the whole of recording for one page. */
export interface ReplaySession extends ReplayControl {
  /** Every session this page knew to be recorded, for the withdrawal. */
  readonly sessions: readonly string[];
}

export type CreateReplay = (environment: ReplayEnvironment) => ReplaySession;
/** Loads the recorder file: a script beside this one (script tag) or a dynamic import (npm). */
export type RecorderLoader = () => Promise<CreateReplay>;
export type ReplayFactory = (environment: ReplayEnvironment) => ReplayControl;

const idOf = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** The control for a page, with the loader of its recorder file. */
export const replayControl =
  (load: RecorderLoader): ReplayFactory =>
  (environment) => {
    const { host } = environment;
    let granted = false;
    let full: ReplaySession | undefined;
    let loading: Promise<unknown> | undefined;
    /** An answer that arrived while the recorder was loading: the latest one says it all. */
    let last: unknown;
    /** The session of an answer or the tab's record, for a withdrawal before the recorder is there. */
    let session: string | undefined;
    /** Sessions a `reset()` ended before the recorder was there: a withdrawal names them too. */
    const ended = new Set<string>();

    const start = () =>
      (loading ??= load()
        .then((create) => {
          full = create(environment);
          if (!granted) return;
          full.consent(true);
          if (last !== undefined) full.answer(last);
        })
        .catch((error: unknown) => environment.warn("the recorder could not be loaded", error)));

    const forget = () => {
      try {
        host.sessionStorage.removeItem(REPLAY_KEY);
        host.sessionStorage.removeItem(LIVE_KEY);
      } catch {
        // Nothing to remove.
      }
    };
    /** The tab's mark goes when the page is left (also into the back-forward cache). */
    let watching = false;
    const leave = () => {
      try {
        host.sessionStorage.removeItem(LIVE_KEY);
      } catch {
        // No storage, no mark.
      }
    };

    const withdraw = (id: string, again = true) => {
      const url = `${environment.ingest}/v1/replay/withdraw?key=${encodeURIComponent(environment.key)}&session=${encodeURIComponent(id)}`;
      environment
        .fetch(url, { method: "POST", keepalive: true, credentials: "omit" })
        .then((response) => response.status === 429 || response.status === 503)
        .catch(() => true)
        .then((repeat) => {
          if (repeat && again) setTimeout(() => withdraw(id, false), 5_000);
        })
        .catch(() => {});
    };

    return {
      answer(body) {
        if (!granted) return;
        if (full) return full.answer(body);
        const id = idOf((body as { replay?: { session_id?: unknown } } | null)?.replay?.session_id);
        if (!id) return;
        session = id;
        last = body;
        void start();
      },
      consent(next) {
        if (next === granted) return;
        granted = next;
        if (next) {
          if (full) return full.consent(true);
          try {
            const store = host.sessionStorage;
            const stored = JSON.parse(store.getItem(REPLAY_KEY) ?? "null");
            session = idOf(stored?.answer?.session_id);
            if (session) {
              // Copied from a tab still open: a tab of its own. Then this page holds the mark.
              if (store.getItem(LIVE_KEY) !== null) dropTab(store);
              store.setItem(LIVE_KEY, "1");
            }
          } catch {
            // No storage, no record.
          }
          if (!watching) {
            watching = true;
            host.addEventListener("pagehide", leave);
          }
          if (session) void start();
          return;
        }
        // Withdrawn: the recorder stops and drops its buffer; the tab's record goes; the server
        // deletes what it stored.
        const ids = new Set([...ended, ...(full?.sessions ?? [])]);
        if (session) ids.add(session);
        ended.clear();
        full?.consent(false);
        session = undefined;
        last = undefined;
        forget();
        for (const id of ids) withdraw(id);
      },
      reset() {
        if (!granted) return;
        if (full) return full.reset();
        // Not loaded yet: the session ends here all the same.
        if (session) ended.add(session);
        session = undefined;
        last = undefined;
        forget();
      },
      hide: () => full?.hide(),
      shown(persisted) {
        if (!persisted || !granted) return;
        if (full) return full.shown(true);
        // Back from the back-forward cache before the recorder was there: the mark again.
        if (session) {
          try {
            host.sessionStorage.setItem(LIVE_KEY, "1");
          } catch {
            // No storage, no mark.
          }
        }
      },
    };
  };
