/**
 * The recorder file: `@rrweb/record` with MIRA FIVE's masking, PII guard, problem capture and
 * chunks. Loaded only when the server records the session and the visitor allows analytics
 * (`control.ts`); never part of the base script.
 */
import { record } from "@rrweb/record";

import type { CreateReplay } from "./control";
import { CAPTURE_PLUGIN, watchProblems, type Problem } from "./capture";
import { createChunker } from "./chunker";
import { canCompress, compress } from "./gzip";
import { masksAllText, neverRecorded, recordOptions, type Masking } from "./masking";
import { sanitize, type NodeOf, type RecordedEvent } from "./sanitize";
import {
  replaySession,
  type RecorderContext,
  type RecorderHandle,
  type StartRecorder,
} from "./session";

/** What the recorder needs from rrweb, so tests can stand in for it. */
export interface Rrweb {
  record(options: Record<string, unknown>): (() => void) | undefined;
  takeFullSnapshot(): void;
}

/** While a never-recorded page is shown, the path is looked at this often to resume. */
const WATCH_MS = 1_000;

/**
 * Where later work hooks in: the actions an assistant's transcript notes (a click with the label of
 * what was clicked, a field that was touched; MF2-248) and the behavior signals (MF2-245) will read
 * each recorded event here. Nothing reads them yet.
 */
function notice(_event: RecordedEvent): void {}

const idle = (host: RecorderContext["host"]) => (work: () => void) => {
  const call = () => {
    try {
      work();
    } catch {
      // Counted by the caller's guard; the page never sees it.
    }
  };
  if (typeof host.requestIdleCallback === "function")
    host.requestIdleCallback(call, { timeout: 2_000 });
  else setTimeout(call, 50);
};

export function createRecorder(
  context: RecorderContext,
  rrweb: Rrweb,
  environment: { canCompress: boolean; compress: typeof compress },
): RecorderHandle | undefined {
  if (!environment.canCompress) {
    context.warn("this browser has no CompressionStream: nothing is recorded");
    return undefined;
  }
  const { host } = context;
  let answer = context.answer;
  let path = host.location.pathname;
  let stopRecord: (() => void) | undefined;
  let paused = false;
  let stopped = false;
  let watching: ReturnType<typeof setInterval> | undefined;
  let nodeOf: NodeOf = () => undefined;
  const counts = { dropped: 0, failed: 0 };
  const count = (what: keyof typeof counts, error?: unknown) => {
    counts[what] += 1;
    if (what === "failed") context.warn("recording failed", error);
  };
  const masking: Masking = {
    get answer() {
      return answer;
    },
    path: () => host.location.pathname,
  };

  const chunker = createChunker({
    ...context,
    session: answer.session_id,
    compress: environment.compress,
    now: () => Date.now(),
    idle: idle(host),
    takeFullSnapshot: () => {
      if (stopRecord) rrweb.takeFullSnapshot();
    },
    stop: (scope) => {
      halt();
      context.stopped(scope);
    },
    count: (what) => count(what),
  });

  const end = () => {
    const stop = stopRecord;
    stopRecord = undefined;
    try {
      stop?.();
    } catch (error) {
      count("failed", error);
    }
  };

  function halt() {
    stopped = true;
    clearInterval(watching);
    watching = undefined;
    end();
  }

  /** A page that is never recorded: send what came before, record nothing, look for the next page. */
  function pause() {
    paused = true;
    chunker.cut();
    // Not from inside rrweb's own emit: stop once it has returned.
    queueMicrotask(end);
    clearInterval(watching);
    watching = setInterval(() => {
      const next = host.location.pathname;
      if (next === path) return;
      path = next;
      if (neverRecorded(answer, next)) return;
      clearInterval(watching);
      watching = undefined;
      begin();
    }, WATCH_MS);
  }

  function emit(event: RecordedEvent) {
    try {
      if (stopped || paused) return;
      const now = host.location.pathname;
      if (now !== path) {
        path = now;
        // Checked on every event, so nothing of a never-recorded page is kept.
        if (neverRecorded(answer, now)) return pause();
      }
      notice(event);
      chunker.add(event, path);
    } catch (error) {
      count("failed", error);
    }
  }

  function begin() {
    if (stopped) return;
    paused = false;
    path = host.location.pathname;
    if (neverRecorded(answer, path)) return pause();
    try {
      stopRecord = rrweb.record({
        emit,
        ...recordOptions(masking),
        plugins: [
          {
            name: "mira/guard@1",
            getMirror: ({ nodeMirror }: { nodeMirror: { getNode(id: number): unknown } }) => {
              nodeOf = (id) => nodeMirror.getNode(id);
            },
            eventProcessor: (event: RecordedEvent) => sanitize(event, nodeOf),
            options: {},
          },
          {
            name: CAPTURE_PLUGIN,
            observer: (report: (problem: Problem) => void, win: typeof globalThis) =>
              watchProblems(
                win,
                report,
                (url) => url.startsWith(context.ingest),
                () => masksAllText(answer, host.location.pathname),
              ),
            options: {},
          },
        ],
        errorHandler: (error: unknown) => {
          count("failed", error);
          return true;
        },
      });
    } catch (error) {
      count("failed", error);
      halt();
      context.stopped("page");
    }
  }

  // The full snapshot is one synchronous task as long as the page is large: it waits for a moment
  // the browser has nothing else to do.
  idle(host)(begin);

  return {
    update(next) {
      answer = next;
      if (!paused && !stopped && neverRecorded(next, host.location.pathname)) pause();
    },
    cut: () => chunker.cut(),
    hide: () => chunker.hide(),
    resume() {
      if (stopped || paused || !stopRecord) return;
      chunker.cut();
      rrweb.takeFullSnapshot();
    },
    stop(keep) {
      halt();
      chunker.stop(keep);
    },
  };
}

/** The recorder of this file, with rrweb and the browser's gzip. */
export const startRecorder: StartRecorder = (context) =>
  createRecorder(
    context,
    {
      record: (options) => record(options as Parameters<typeof record>[0]),
      takeFullSnapshot: () => record.takeFullSnapshot(),
    },
    { canCompress: canCompress(context.host), compress },
  );

/** Recording for one page: what the base script loads. */
export const createReplay: CreateReplay = (environment) =>
  replaySession(environment, startRecorder);
