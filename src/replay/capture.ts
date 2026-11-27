/**
 * Console errors, uncaught exceptions and failed network requests, recorded as rrweb plugin events
 * (type 6) in the same array as the page: what went wrong, where and when. A request is its URL's
 * origin and path, its method, status and duration; never a body, a header or a query string.
 * Every text passes the PII guard.
 */
import { redact } from "./masking";

/** The plugin's name in the recording (`data.plugin` of its events). */
export const CAPTURE_PLUGIN = "mira/problems@1";

export type Problem =
  | { kind: "console"; message: string }
  | { kind: "exception"; message: string; source?: string }
  | { kind: "request"; method: string; url: string; status: number; duration: number };

/** At most this many per page, so a page that logs in a loop cannot fill the recording. */
export const MAX_PROBLEMS = 100;
const MAX_TEXT = 500;

/** An URL as it may be recorded: origin and path, no query or fragment, through the guard. */
export function requestUrl(url: unknown, base: string): string {
  try {
    const parsed = new URL(String(url), base);
    return redact(`${parsed.origin}${parsed.pathname}`).slice(0, 512);
  } catch {
    return "";
  }
}

/** A console argument or a thrown value as text: its message, never its properties. */
export function describe(value: unknown): string {
  let text: string;
  if (value instanceof Error) text = `${value.name}: ${value.message}`;
  else if (typeof value === "string") text = value;
  else if (value === null || ["number", "boolean", "undefined", "bigint"].includes(typeof value)) {
    text = String(value);
  } else text = Object.prototype.toString.call(value);
  return redact(text.slice(0, MAX_TEXT));
}

type Window = typeof globalThis & {
  XMLHttpRequest?: typeof XMLHttpRequest;
};

/**
 * Starts listening; returns the function that stops. `ignore` names URLs that are not the page's
 * own requests (the ingest). Patches `console.error`, `fetch` and `XMLHttpRequest` while it runs and
 * puts back what it found, unless someone patched them again after it.
 */
export function watchProblems(
  win: Window,
  report: (problem: Problem) => void,
  ignore: (url: string) => boolean,
): () => void {
  let count = 0;
  const emit = (problem: Problem) => {
    if (count >= MAX_PROBLEMS) return;
    count += 1;
    try {
      report(problem);
    } catch {
      // Never in the page's way.
    }
  };
  const base = () => win.location?.href ?? "";
  const undo: (() => void)[] = [];

  const onError = (event: ErrorEvent) =>
    emit({
      kind: "exception",
      message: describe(event.error ?? event.message),
      ...(event.filename
        ? { source: `${requestUrl(event.filename, base())}:${event.lineno}:${event.colno}` }
        : {}),
    });
  const onRejection = (event: PromiseRejectionEvent) =>
    emit({ kind: "exception", message: describe(event.reason) });
  win.addEventListener("error", onError as EventListener, { passive: true });
  win.addEventListener("unhandledrejection", onRejection as EventListener, { passive: true });
  undo.push(() => {
    win.removeEventListener("error", onError as EventListener);
    win.removeEventListener("unhandledrejection", onRejection as EventListener);
  });

  const console = win.console;
  const originalError = console?.error;
  if (console && typeof originalError === "function") {
    const patched = function (this: unknown, ...args: unknown[]) {
      emit({ kind: "console", message: args.map(describe).join(" ").slice(0, MAX_TEXT) });
      return originalError.apply(this, args);
    };
    console.error = patched;
    undo.push(() => {
      if (console.error === patched) console.error = originalError;
    });
  }

  const request = (method: string, url: string, status: number, started: number) => {
    if (status > 0 && status < 400) return;
    const recorded = requestUrl(url, base());
    if (!recorded || ignore(recorded)) return;
    emit({
      kind: "request",
      method: method.toUpperCase().slice(0, 10),
      url: recorded,
      status,
      duration: Math.round(performance.now() - started),
    });
  };

  const originalFetch = win.fetch;
  if (typeof originalFetch === "function") {
    const patched = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const started = performance.now();
      const promise = originalFetch.call(this ?? win, input, init);
      try {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        // A side branch: the page gets the original promise, rejections included.
        promise.then(
          (response) => request(method, url, response.status, started),
          () => request(method, url, 0, started),
        );
      } catch {
        // Recording never changes what the page's request does.
      }
      return promise;
    } as typeof fetch;
    win.fetch = patched;
    undo.push(() => {
      if (win.fetch === patched) win.fetch = originalFetch;
    });
  }

  const proto = win.XMLHttpRequest?.prototype;
  if (proto) {
    // Called with the request as `this`, as the page's own calls would.
    // oxlint-disable-next-line typescript/unbound-method
    const { open, send } = proto;
    const calls = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    const patchedOpen = function (this: XMLHttpRequest, ...args: unknown[]) {
      calls.set(this, { method: String(args[0]), url: String(args[1]) });
      return Reflect.apply(open, this, args) as void;
    } as typeof open;
    const patchedSend = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      const call = calls.get(this);
      if (call) {
        const started = performance.now();
        this.addEventListener(
          "loadend",
          () => request(call.method, call.url, this.status, started),
          { once: true, passive: true },
        );
      }
      return send.call(this, body);
    };
    proto.open = patchedOpen;
    proto.send = patchedSend;
    undo.push(() => {
      if (proto.open === patchedOpen) proto.open = open;
      if (proto.send === patchedSend) proto.send = send;
    });
  }

  return () => {
    for (const action of undo.splice(0)) {
      try {
        action();
      } catch {
        // Nothing to put back.
      }
    }
  };
}
