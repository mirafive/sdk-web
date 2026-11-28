/**
 * Recording for one page, in the recorder file (docs/replay.md, Wire, 1): the server's decision from
 * each batch's `202`, the tab's record of it in `sessionStorage` (the next page records from its
 * first moment and goes on with the tab's stream), and when to start, change or stop the recorder.
 *
 * A recording is one stream per tab: the server gives two tabs of one visit the same session, so
 * each tab names itself (`tab`, a random id kept in the tab's record) and numbers its chunks from
 * 0. A tab whose record was copied from another live tab (`control.ts`, `LIVE_KEY`) gets a new id.
 */
import { isTabId, readReplayAnswer, REPLAY_LIMITS, type ReplayAnswer } from "@mirafive/protocol";

import { LIVE_KEY, REPLAY_KEY, type ReplayEnvironment, type ReplaySession } from "./control";

/**
 * The tab's record of a recorded session: the decision, the tab's id, its next chunk number, when
 * it was made. Without a tab (a copied record, `dropTab`), the page records as a new tab.
 */
export interface ReplayEntry {
  answer: ReplayAnswer;
  tab?: string;
  seq: number;
  at: number;
}

/** A new tab id: 16 characters of base64url from 12 random bytes (`TAB_ID`). */
export function newTabId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

/** The record as stored, or `undefined` when it is missing, malformed or older than a decision lives. */
export function readEntry(raw: string | null | undefined, now: number): ReplayEntry | undefined {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (typeof value !== "object" || value === null) return undefined;
    const { answer, tab, seq, at } = value as Record<string, unknown>;
    const read = readReplayAnswer({ replay: answer });
    if (!read || typeof seq !== "number" || !Number.isInteger(seq) || typeof at !== "number") {
      return undefined;
    }
    if (seq < 0 || seq > REPLAY_LIMITS.maxSequence) return undefined;
    if (now - at > REPLAY_LIMITS.sessionMs || at > now + REPLAY_LIMITS.futureMs) return undefined;
    // A tab id that is not one starts the page as a new tab, from chunk 0.
    if (typeof tab !== "string" || !isTabId(tab)) return { answer: read, seq: 0, at };
    return { answer: read, tab, seq, at };
  } catch {
    return undefined;
  }
}

/** What the recorder of one page gets. */
export interface RecorderContext extends ReplayEnvironment {
  answer: ReplayAnswer;
  /** The tab's id: its stream of the session. */
  tab: string;
  /** Takes the next chunk number of the tab's stream and keeps it for the tab's next page. */
  nextSeq(): number;
  /** The recorder stopped on its own: for this page (401, 402, 403, repeated 429) or the session (409). */
  stopped(scope: "page" | "session"): void;
}

export interface RecorderHandle {
  /** New settings for the running session (masking, page lists), from a later batch. */
  update(answer: ReplayAnswer): void;
  /** Sends what is buffered as its own chunk, under the ids of now (before `reset` changes them). */
  cut(): void;
  /** The page is hidden or left: send what fits a beacon. */
  hide(): void;
  /**
   * The page came back from the back-forward cache: another page of the tab may have recorded in
   * between, so the stream goes on from a new full snapshot.
   */
  resume(): void;
  /** Stops. `keep`: send what is buffered; otherwise drop it (consent withdrawn). */
  stop(keep: boolean): void;
}

/** Starts recording a page; `undefined` when this browser cannot (no `CompressionStream`). */
export type StartRecorder = (context: RecorderContext) => RecorderHandle | undefined;

/**
 * Runs `action` once the page is shown: never while prerendered or hidden since it started.
 * Returns the function that cancels the wait, or `undefined` when `action` ran at once.
 */
export function whenShown(document: Document, action: () => void): (() => void) | undefined {
  const shown = () =>
    !(document as Document & { prerendering?: boolean }).prerendering &&
    document.visibilityState !== "hidden";
  if (shown()) {
    action();
    return undefined;
  }
  const check = () => {
    if (!shown()) return;
    cancel();
    action();
  };
  const cancel = () => {
    document.removeEventListener("prerenderingchange", check);
    document.removeEventListener("visibilitychange", check);
  };
  document.addEventListener("prerenderingchange", check);
  document.addEventListener("visibilitychange", check);
  return cancel;
}

export function replaySession(environment: ReplayEnvironment, start: StartRecorder): ReplaySession {
  const { host } = environment;
  let granted = false;
  let entry: ReplayEntry | undefined;
  let recorder: RecorderHandle | undefined;
  /** A refusal for the page, or a browser that cannot record: nothing more on this page. */
  let pageStopped = false;
  /**
   * Sessions that end here: refused by the server (`409`), or left by `reset()`. Their later
   * answers start nothing on this page.
   */
  const ended = new Set<string>();
  /** The next chunk number of each session this page recorded, so a stream never reuses one. */
  const numbers = new Map<string, number>();
  /** This tab's id: from its record, or made when it first records. */
  let tabId: string | undefined;
  /** Recorders of earlier sessions still sending what they had: dropped if consent goes. */
  const closing: RecorderHandle[] = [];
  /** Every session this page knew to be recorded, for the withdrawal. */
  const seen = new Set<string>();
  let waiting: (() => void) | undefined;

  // `sessionStorage` can throw (sandboxed frames, storage blocked); recording then just stays off.
  const storage = <T>(action: (store: Storage) => T): T | undefined => {
    try {
      return action(host.sessionStorage);
    } catch {
      return undefined;
    }
  };
  // The record, and the claim that a document of this tab records now (`LIVE_KEY`), go together.
  const save = () =>
    storage((store) => {
      if (!entry) {
        store.removeItem(REPLAY_KEY);
        store.removeItem(LIVE_KEY);
        return;
      }
      store.setItem(REPLAY_KEY, JSON.stringify(entry));
      store.setItem(LIVE_KEY, "1");
    });
  /**
   * The next number the tab's record holds for this stream, or 0: an earlier page of the tab, back
   * from the back-forward cache, goes on after what the pages in between sent.
   */
  const recorded = (id: string, tab: string): number => {
    const stored = readEntry(
      storage((store) => store.getItem(REPLAY_KEY)),
      Date.now(),
    );
    return stored?.answer.session_id === id && stored.tab === tab ? stored.seq : 0;
  };
  const take = (next: ReplayEntry | undefined) => {
    if (next) {
      tabId = next.tab ?? tabId ?? newTabId();
      next.tab = tabId;
      seen.add(next.answer.session_id);
    }
    entry = next;
    save();
  };

  /** Stops the running recorder: `keep` lets it send what it has (and keeps it until it is done). */
  const stop = (keep: boolean) => {
    waiting?.();
    waiting = undefined;
    if (!recorder) return;
    recorder.stop(keep);
    if (keep) closing.push(recorder);
    recorder = undefined;
  };

  const begin = () => {
    if (!granted || !entry || recorder || waiting || pageStopped) return;
    const own = entry;
    const id = own.answer.session_id;
    const tab = own.tab ?? newTabId();
    waiting = whenShown(host.document, () => {
      waiting = undefined;
      if (!granted || entry !== own || recorder) return;
      recorder = start({
        ...environment,
        answer: own.answer,
        tab,
        nextSeq: () => {
          const seq = Math.max(own.seq, entry === own ? recorded(id, tab) : 0);
          own.seq = seq + 1;
          numbers.set(id, own.seq);
          if (entry === own) save();
          return seq;
        },
        stopped: (scope) => {
          if (entry !== own) return;
          recorder = undefined;
          if (scope === "page") {
            pageStopped = true;
            return;
          }
          ended.add(id);
          take(undefined);
        },
      });
      if (!recorder) pageStopped = true;
    });
  };

  return {
    get sessions() {
      return [...seen];
    },
    answer(body) {
      if (!granted) return;
      const accepted = (body as { accepted?: unknown } | null)?.accepted;
      // A retry the server had seen already says nothing new.
      if (typeof accepted !== "number" || accepted <= 0) return;
      const replay = readReplayAnswer(body);
      if (replay && ended.has(replay.session_id)) return;
      if (replay && entry?.answer.session_id === replay.session_id) {
        entry.answer = replay;
        save();
        recorder?.update(replay);
        begin();
        return;
      }
      // Another session, or none: what is buffered still goes to the old one.
      stop(true);
      take(replay && { answer: replay, seq: numbers.get(replay.session_id) ?? 0, at: Date.now() });
      begin();
    },
    consent(next) {
      if (next === granted) return;
      granted = next;
      if (granted) {
        const stored =
          entry ??
          readEntry(
            storage((store) => store.getItem(REPLAY_KEY)),
            Date.now(),
          );
        if (stored && !ended.has(stored.answer.session_id)) {
          numbers.set(stored.answer.session_id, stored.seq);
          take(stored);
        }
        begin();
        return;
      }
      // Withdrawn: every recorder stops and drops what it has, also those still sending for an
      // earlier session; the tab's record goes (the base script sends the withdrawals).
      stop(false);
      for (const handle of closing.splice(0)) handle.stop(false);
      take(undefined);
    },
    reset() {
      // Logout: what was recorded leaves under the old ids, and the session ends here, so nothing
      // after this is tied to it. Recording starts again only with a new decision of the server.
      stop(true);
      if (entry) ended.add(entry.answer.session_id);
      take(undefined);
    },
    hide: () => recorder?.hide(),
    shown(persisted) {
      if (!persisted || !entry) return;
      // Back from the back-forward cache: this document records in the tab again, after what the
      // pages in between sent.
      if (entry.tab) entry.seq = Math.max(entry.seq, recorded(entry.answer.session_id, entry.tab));
      save();
      recorder?.resume();
    },
  };
}
