/**
 * Recording for one page, in the recorder file (docs/replay.md, Wire, 1): the server's decision from
 * each batch's `202`, the tab's record of it in `sessionStorage` (the next page records from its
 * first moment and goes on with the chunk numbers), and when to start, change or stop the recorder.
 */
import { readReplayAnswer, REPLAY_LIMITS, type ReplayAnswer } from "@mirafive/protocol";

import { REPLAY_KEY, type ReplayEnvironment, type ReplaySession } from "./control";

/** The tab's record of a recorded session: the decision, the next chunk number, when it was made. */
export interface ReplayEntry {
  answer: ReplayAnswer;
  seq: number;
  at: number;
}

/** The record as stored, or `undefined` when it is missing, malformed or older than a decision lives. */
export function readEntry(raw: string | null | undefined, now: number): ReplayEntry | undefined {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (typeof value !== "object" || value === null) return undefined;
    const { answer, seq, at } = value as Record<string, unknown>;
    const read = readReplayAnswer({ replay: answer });
    if (!read || typeof seq !== "number" || !Number.isInteger(seq) || typeof at !== "number") {
      return undefined;
    }
    if (seq < 0 || seq > REPLAY_LIMITS.maxSequence) return undefined;
    if (now - at > REPLAY_LIMITS.sessionMs || at > now + REPLAY_LIMITS.futureMs) return undefined;
    return { answer: read, seq, at };
  } catch {
    return undefined;
  }
}

/** What the recorder of one page gets. */
export interface RecorderContext extends ReplayEnvironment {
  answer: ReplayAnswer;
  /** Takes the next chunk number of the session and keeps it for the tab's next page. */
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
  /** The next chunk number of each session this page recorded, so a session never reuses one. */
  const numbers = new Map<string, number>();
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
  const save = () =>
    storage((store) =>
      entry ? store.setItem(REPLAY_KEY, JSON.stringify(entry)) : store.removeItem(REPLAY_KEY),
    );
  const take = (next: ReplayEntry | undefined) => {
    entry = next;
    if (next) seen.add(next.answer.session_id);
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
    waiting = whenShown(host.document, () => {
      waiting = undefined;
      if (!granted || entry !== own || recorder) return;
      recorder = start({
        ...environment,
        answer: own.answer,
        nextSeq: () => {
          const seq = own.seq;
          own.seq += 1;
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
  };
}
