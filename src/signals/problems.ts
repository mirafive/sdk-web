/**
 * The error signal (docs/replay.md, Behavior signals): an uncaught exception, an unhandled
 * rejection, or a request of the site's own that failed with an HTTP error. What is not the site's
 * is left out: a browser extension's errors, "Script error." of a script without CORS (it says
 * nothing), the benign ResizeObserver loop, aborted requests, other sites' requests (ad blockers
 * block those) and requests that failed without a status (blocked, offline or cut off by leaving:
 * they cannot be told apart). A request is its origin and path, method and status; never its
 * query, body or headers.
 */
import { redactPii, SIGNAL_LIMITS } from "@mirafive/protocol";

export interface Problem {
  kind: "exception" | "rejection" | "request";
  message: string;
  source?: string;
  url?: string;
  method?: string;
  status?: number;
}

const EXTENSIONS = /(chrome|moz|safari-web)-extension:\/\//;
const NOISE =
  /^(Script error\.?|ResizeObserver loop (limit exceeded|completed with undelivered notifications)\.?)$/;

const text = (value: string) => redactPii(value).text.slice(0, SIGNAL_LIMITS.textLength);

/** An URL as a signal may carry it: origin and path, no query or fragment. */
export function bareUrl(url: string, base: string): string {
  try {
    const parsed = new URL(url, base);
    return redactPii(`${parsed.origin}${parsed.pathname}`, () => "").text.slice(0, 512);
  } catch {
    return "";
  }
}

/** A thrown value as text: its name and message, never its properties. */
export function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  return Object.prototype.toString.call(value);
}

/** The exception as a problem, or undefined when it is not the site's to fix. */
export function exceptionOf(
  error: unknown,
  message: string,
  filename: string,
  line: number,
  column: number,
  base: string,
): Problem | undefined {
  const said = error === undefined || error === null ? message : describe(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  if (!said || NOISE.test(said.trim()) || NOISE.test(message.trim())) return undefined;
  if (EXTENSIONS.test(filename) || EXTENSIONS.test(stack)) return undefined;
  return {
    kind: "exception",
    message: text(said),
    ...(filename ? { source: `${bareUrl(filename, base)}:${line}:${column}` } : {}),
  };
}

/** The rejection as a problem, or undefined: an abort is no error, nor an extension's. */
export function rejectionOf(reason: unknown): Problem | undefined {
  if (reason instanceof Error && reason.name === "AbortError") return undefined;
  if (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { name?: unknown }).name === "AbortError"
  ) {
    return undefined;
  }
  const stack = reason instanceof Error ? (reason.stack ?? "") : "";
  if (EXTENSIONS.test(stack)) return undefined;
  const said = describe(reason);
  if (NOISE.test(said.trim())) return undefined;
  return { kind: "rejection", message: text(said) };
}

const siteOf = (hostname: string) => hostname.replace(/^www\./, "");

/** Whether a request goes to the page's own site: the same host or one a subdomain of the other. */
export function ownSite(url: string, base: string): boolean {
  try {
    const host = siteOf(new URL(url, base).hostname);
    const page = siteOf(new URL(base).hostname);
    return host === page || host.endsWith(`.${page}`) || page.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

/** A finished request as a problem: only an HTTP error of the site's own requests. */
export function requestOf(
  method: string,
  url: string,
  status: number,
  base: string,
): Problem | undefined {
  if (status < 400 || !ownSite(url, base)) return undefined;
  const bare = bareUrl(url, base);
  if (!bare) return undefined;
  const verb = method.toUpperCase().slice(0, 10);
  return {
    kind: "request",
    message: `${verb} ${new URL(bare).pathname} ${status}`,
    url: bare,
    method: verb,
    status,
  };
}

type Window = typeof globalThis & { XMLHttpRequest?: typeof XMLHttpRequest };

/**
 * Listens for problems and for every request the page starts (a dead click's "no request"). Patches
 * `fetch` and `XMLHttpRequest` as a side branch: the page gets the original promise and request,
 * rejections included, and the patch is removed only if nobody patched them again after it.
 */
export function watchProblems(
  win: Window,
  report: (problem: Problem) => void,
  started: () => void,
): void {
  const base = () => win.location?.href ?? "";
  const guard = (action: () => void) => {
    try {
      action();
    } catch {
      // Never in the page's way.
    }
  };
  const emit = (problem: Problem | undefined) => {
    if (problem) report(problem);
  };

  win.addEventListener(
    "error",
    ((event: ErrorEvent) =>
      guard(() =>
        emit(
          exceptionOf(
            event.error,
            event.message ?? "",
            event.filename ?? "",
            event.lineno ?? 0,
            event.colno ?? 0,
            base(),
          ),
        ),
      )) as EventListener,
    { passive: true },
  );
  win.addEventListener(
    "unhandledrejection",
    ((event: PromiseRejectionEvent) =>
      guard(() => emit(rejectionOf(event.reason)))) as EventListener,
    { passive: true },
  );

  const finished = (method: string, url: string, status: number) =>
    guard(() => emit(requestOf(method, url, status, base())));

  const originalFetch = win.fetch;
  if (typeof originalFetch === "function") {
    win.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const promise = originalFetch.call(this ?? win, input, init);
      guard(() => {
        const url =
          typeof Request !== "undefined" && input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : `${input as string}`;
        started();
        const method =
          init?.method ??
          (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
        promise.then(
          (response) => finished(method, url, response.status),
          () => {},
        );
      });
      return promise;
    } as typeof fetch;
  }

  const proto = win.XMLHttpRequest?.prototype;
  if (proto) {
    // Called with the request as `this`, as the page's own calls would.
    // oxlint-disable-next-line typescript/unbound-method
    const { open, send } = proto;
    const calls = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    proto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      guard(() => calls.set(this, { method: String(args[0]), url: String(args[1]) }));
      return Reflect.apply(open, this, args) as void;
    } as typeof open;
    proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      guard(() => {
        const call = calls.get(this);
        if (!call) return;
        started();
        this.addEventListener("loadend", () => finished(call.method, call.url, this.status), {
          once: true,
          passive: true,
        });
      });
      return send.call(this, body);
    };
  }
}
