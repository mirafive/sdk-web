import type { ConsentState } from "@mirafive/protocol";

import type { ConsentAdapter, ConsentStatus } from "./types";

/**
 * Google Consent Mode v2, read from the `dataLayer` (fallback when no CMP is detected).
 *
 * `gtag('consent', 'default' | 'update', {...})` pushes its `arguments` object onto `window.dataLayer`
 * (Google's gtag.js and Consent Mode docs). We replay every consent command in order and wrap
 * `dataLayer.push` to see later updates. GTM and gtag.js keep a previously installed `push` in
 * their own wrapper, so the order in which scripts load does not matter.
 *
 * Mapping: `analytics_storage` → analytics; `ad_storage` and `ad_user_data` (both granted) →
 * marketing. A purpose that only has a `default` of `denied` reads as `unknown`: the default is
 * the site's state before the person answered, not an answer.
 */
type Signal = "granted" | "denied";
interface Seen {
  value: Signal;
  updated: boolean;
}

const isCommand = (entry: unknown): entry is ArrayLike<unknown> =>
  Boolean(entry) && typeof entry === "object" && (entry as ArrayLike<unknown>)[0] === "consent";

export function fromDataLayer(entries: ArrayLike<unknown>): ConsentStatus | undefined {
  const seen: Record<string, Seen> = {};
  let found = false;
  for (const entry of Array.from(entries)) {
    if (!isCommand(entry)) continue;
    const kind = entry[1];
    const values = entry[2] as Record<string, unknown> | undefined;
    if ((kind !== "default" && kind !== "update") || !values) continue;
    found = true;
    for (const [key, value] of Object.entries(values)) {
      if (value === "granted" || value === "denied") {
        seen[key] = { value, updated: kind === "update" || seen[key]?.updated === true };
      }
    }
  }
  if (!found) return undefined;

  const read = (...keys: string[]): ConsentState => {
    const signals = keys.map((key) => seen[key]);
    if (signals.every((signal) => signal?.value === "granted")) return "granted";
    // A denial counts only once the person (or the CMP for them) updated it.
    return signals.some((signal) => signal?.value === "denied" && signal.updated)
      ? "denied"
      : "unknown";
  };
  return { analytics: read("analytics_storage"), marketing: read("ad_storage", "ad_user_data") };
}

export const consentMode: ConsentAdapter = {
  name: "consent-mode",
  fallback: true,
  detect: (host) =>
    Array.isArray(host.dataLayer) && fromDataLayer(host.dataLayer as unknown[]) !== undefined,
  subscribe(host, emit) {
    const layer = host.dataLayer as unknown[] & { push: (...items: unknown[]) => number };
    const report = () => {
      const status = fromDataLayer(layer);
      if (status) emit(status);
    };
    const original = layer.push;
    const wrapped = function (this: unknown, ...items: unknown[]) {
      const result = original.apply(this, items);
      if (items.some(isCommand)) report();
      return result;
    };
    layer.push = wrapped;
    report();
    return () => {
      // Only unwrap if nobody wrapped us in the meantime; otherwise their chain would break.
      if (layer.push === wrapped) layer.push = original;
    };
  },
};
