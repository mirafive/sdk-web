/**
 * The script-tag entry of pixel mode, built to `dist/mira-shopify-pixel.js` (its own file, so the
 * script every site loads does not carry it). A Shopify custom pixel loads it:
 *
 * ```js
 * window.mira = window.mira || function () { (mira.q = mira.q || []).push(arguments); };
 * mira("shopifyPixel", { analytics, init, browser, customerPrivacy: typeof api !== "undefined" ? api.customerPrivacy : undefined, key: "mira_pk_…" });
 * // …then a script element for /sdk/v2/mira-shopify-pixel.js
 * ```
 *
 * Other `mira(...)` calls queued before it loads are replayed on the pixel's instance, and `mira`
 * then calls that instance.
 */
import type { Host } from "../consent/types";
import type { Mira } from "../mira";
import { startShopifyPixel, type ShopifyPixelInput } from "./pixel";

type Stub = ((...args: unknown[]) => unknown) & { q?: ArrayLike<unknown>[]; loaded?: boolean };

async function boot() {
  const host = window as unknown as Host & { mira?: Stub };
  if (host.mira?.loaded) return;
  const queue = Array.from(host.mira?.q ?? []);
  const start = queue.find((entry) => entry[0] === "shopifyPixel");
  const input = start?.[1] as ShopifyPixelInput | undefined;
  if (!input) {
    console.warn(
      "MIRA FIVE: mira('shopifyPixel', { analytics, init, browser, key }) was not called.",
    );
    return;
  }

  let instance: Mira | undefined;
  const run = (command: unknown, args: unknown[]) => {
    const call = (instance as unknown as Record<string, unknown> | undefined)?.[String(command)];
    return typeof call === "function" ? call.apply(instance, args) : undefined;
  };
  // Calls made while the pixel starts wait for the instance.
  const waiting: [unknown, unknown[]][] = [];
  host.mira = Object.assign(
    (command: unknown, ...args: unknown[]) => {
      if (instance) return run(command, args);
      waiting.push([command, args]);
      return undefined;
    },
    { loaded: true },
  );
  for (const [command, ...args] of queue.map((entry) => Array.from(entry))) {
    if (command !== "shopifyPixel") waiting.push([command, args]);
  }
  instance = await startShopifyPixel(host, input);
  for (const [command, args] of waiting.splice(0)) run(command, args);
}

void boot().catch(() => {
  // Never break the pixel.
});
