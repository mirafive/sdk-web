import { describe, expect, test } from "bun:test";

import { fakeHost, tick } from "../test/fake-host";
import { defaultAdapters } from "./auto";
import { lazyAdapter, lazyAdapters, type ConsentFile } from "./lazy";
import type { ConsentAdapter, ConsentStatus } from "./types";

const GRANTED: ConsentStatus = { analytics: "granted", marketing: "granted" };

/** A consent file whose one adapter records what it was asked. */
function file() {
  const calls = { subscribed: 0, stopped: 0 };
  const adapter: ConsentAdapter = {
    name: "cookiebot",
    detect: () => true,
    subscribe(_host, emit) {
      calls.subscribed += 1;
      emit(GRANTED);
      return () => {
        calls.stopped += 1;
      };
    },
  };
  return { calls, file: { cookiebot: adapter } satisfies ConsentFile };
}

describe("the script tag's adapters", () => {
  test("are the default adapters, in their order, detecting the same way", () => {
    const lazy = lazyAdapters(() => Promise.reject(new Error("not loaded")));
    expect(lazy.map((adapter) => adapter.name)).toEqual(
      defaultAdapters.map((adapter) => adapter.name),
    );
    expect(lazy.map((adapter) => adapter.fallback === true)).toEqual(
      defaultAdapters.map((adapter) => adapter.fallback === true),
    );
    const detects = (adapters: readonly ConsentAdapter[]) =>
      adapters.map((adapter) => Object.getOwnPropertyDescriptor(adapter, "detect")?.value);
    expect(detects(lazy)).toEqual(detects(defaultAdapters));
  });

  test("subscribe once the consent file is there, with the file's adapter of the same name", async () => {
    const { calls, file: consent } = file();
    const seen: ConsentStatus[] = [];
    const adapter = lazyAdapter(
      "cookiebot",
      () => true,
      () => Promise.resolve(consent),
    );
    const stop = adapter.subscribe(fakeHost().host, (status) => seen.push(status));
    expect(seen).toEqual([]);
    await tick();
    expect(seen).toEqual([GRANTED]);
    stop();
    expect(calls).toEqual({ subscribed: 1, stopped: 1 });
  });

  test("stopped before the file is there, never subscribe", async () => {
    const { calls, file: consent } = file();
    const seen: ConsentStatus[] = [];
    const adapter = lazyAdapter(
      "cookiebot",
      () => true,
      () => Promise.resolve(consent),
    );
    adapter.subscribe(fakeHost().host, (status) => seen.push(status))();
    await tick();
    expect(seen).toEqual([]);
    expect(calls.subscribed).toBe(0);
  });

  test("a file that cannot be loaded leaves the consent as it was, and throws nothing", async () => {
    const seen: ConsentStatus[] = [];
    const adapter = lazyAdapter(
      "cookiebot",
      () => true,
      () => Promise.reject(new Error("blocked")),
    );
    const stop = adapter.subscribe(fakeHost().host, (status) => seen.push(status));
    await tick();
    expect(seen).toEqual([]);
    expect(stop).not.toThrow();
  });

  test("an adapter that throws in the file breaks nothing", async () => {
    const broken: ConsentAdapter = {
      name: "cookiebot",
      detect: () => true,
      subscribe: () => {
        throw new Error("broken CMP");
      },
    };
    const adapter = lazyAdapter(
      "cookiebot",
      () => true,
      () => Promise.resolve({ cookiebot: broken }),
    );
    const stop = adapter.subscribe(fakeHost().host, () => {});
    await tick();
    expect(stop).not.toThrow();
  });
});
