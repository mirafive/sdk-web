/* oxlint-disable typescript/no-unsafe-type-assertion -- test fakes stand in for browser globals */
import { describe, expect, test } from "bun:test";

import {
  describe as describeValue,
  MAX_PROBLEMS,
  requestUrl,
  watchProblems,
  type Problem,
} from "./capture";
import { tick } from "../test/fake-host";

const BASE = "https://shop.example/cart";

/** A window with the globals the capture patches. */
function fakeWindow(answer: (url: string) => Promise<Response>) {
  const target = new EventTarget();
  const logged: unknown[][] = [];
  const win = Object.assign(target, {
    location: { href: BASE },
    console: { error: (...args: unknown[]) => logged.push(args) },
    fetch: (input: string) => answer(input),
  });
  return { win: win as unknown as typeof globalThis, logged };
}

describe("what is recorded of a problem", () => {
  test("a URL is its origin and path, never its query or fragment", () => {
    expect(requestUrl("/api/orders?email=jana@example.com#x", BASE)).toBe(
      "https://shop.example/api/orders",
    );
    expect(requestUrl("https://api.example/v1/users/jana@example.com/orders", BASE)).toBe(
      "https://api.example/v1/users/****************/orders",
    );
    expect(requestUrl("http://[bad", BASE)).toBe("");
  });

  test("a value is its message, through the PII guard, never its properties", () => {
    expect(describeValue(new TypeError("no user jana@example.com"))).toBe(
      "TypeError: no user ****************",
    );
    expect(describeValue({ password: "secret" })).toBe("[object Object]");
    expect(describeValue(42)).toBe("42");
    expect(describeValue("x".repeat(600))).toHaveLength(500);
  });
});

describe("watching", () => {
  test("console errors, uncaught exceptions and rejections", () => {
    const { win, logged } = fakeWindow(() => Promise.resolve(new Response("")));
    const problems: Problem[] = [];
    const stop = watchProblems(
      win,
      (problem) => problems.push(problem),
      () => false,
    );
    win.console.error("failed for", "jana@example.com");
    expect(logged).toEqual([["failed for", "jana@example.com"]]);
    const error = new Event("error") as ErrorEvent;
    Object.assign(error, {
      message: "boom",
      error: new Error("boom"),
      filename: `${BASE}?q=1`,
      lineno: 3,
      colno: 7,
    });
    win.dispatchEvent(error);
    const rejection = new Event("unhandledrejection");
    Object.assign(rejection, { reason: "nope" });
    win.dispatchEvent(rejection);
    expect(problems).toEqual([
      { kind: "console", message: "failed for ****************" },
      { kind: "exception", message: "Error: boom", source: "https://shop.example/cart:3:7" },
      { kind: "exception", message: "nope" },
    ]);
    stop();
  });

  test("failed requests with status and duration; the page gets its own promise back", async () => {
    const answers: Record<string, () => Promise<Response>> = {
      "/ok": () => Promise.resolve(new Response("", { status: 200 })),
      "/missing?id=1": () => Promise.resolve(new Response("", { status: 404 })),
      "/down": () => Promise.reject(new TypeError("Failed to fetch")),
      "https://ingest.example/v1/replay": () => Promise.reject(new TypeError("Failed to fetch")),
    };
    const { win } = fakeWindow((url) => answers[url]!());
    const problems: Problem[] = [];
    const stop = watchProblems(
      win,
      (problem) => problems.push(problem),
      (url) => url.startsWith("https://ingest.example"),
    );
    const response = await win.fetch("/ok");
    expect(response.status).toBe(200);
    await win.fetch("/missing?id=1");
    expect(await win.fetch("/down").catch((error: Error) => error.message)).toBe("Failed to fetch");
    expect(await win.fetch("https://ingest.example/v1/replay").catch(() => "refused")).toBe(
      "refused",
    );
    await tick();
    expect(problems.map(({ duration: _, ...rest }: any) => rest)).toEqual([
      { kind: "request", method: "GET", url: "https://shop.example/missing", status: 404 },
      { kind: "request", method: "GET", url: "https://shop.example/down", status: 0 },
    ]);
    for (const problem of problems) expect(typeof (problem as any).duration).toBe("number");
    stop();
  });

  test("stopping puts back what it patched, and at most 100 problems a page", () => {
    const { win } = fakeWindow(() => Promise.resolve(new Response("")));
    const { fetch, console } = win;
    const original = console.error;
    const problems: Problem[] = [];
    const stop = watchProblems(
      win,
      (problem) => problems.push(problem),
      () => false,
    );
    expect(win.fetch).not.toBe(fetch);
    for (let index = 0; index < 150; index += 1) win.console.error("x");
    expect(problems).toHaveLength(MAX_PROBLEMS);
    stop();
    expect(win.fetch).toBe(fetch);
    expect(win.console.error).toBe(original);
  });

  test("a reporter that throws never reaches the page", () => {
    const { win } = fakeWindow(() => Promise.resolve(new Response("")));
    const stop = watchProblems(
      win,
      () => {
        throw new Error("broken");
      },
      () => false,
    );
    expect(() => win.console.error("x")).not.toThrow();
    stop();
  });
});
