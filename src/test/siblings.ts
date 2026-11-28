/**
 * Serves the script tag's sibling files to a fake host, as the app serves them beside `mira.js`:
 * an appended `mira-<name>@<version>.js` runs the sibling's own script module, which registers it,
 * then fires `load`. An unknown file fires `error`.
 */
import type { FakeHost, FakeScript } from "./fake-host";
import { tick } from "./fake-host";

const SIBLINGS: Record<string, () => Promise<unknown>> = {
  consent: () => import("../consent/consent-script"),
  shopify: () => import("../shopify/shopify-script"),
};

/** Every sibling the page loaded, by name, in order. */
export const loadedSiblings = (fake: FakeHost) =>
  fake.scripts.map((script) => /\/mira-([a-z]+)@[^/]+\.js$/.exec(script.src)?.[1]);

export function serveSiblings(fake: FakeHost, delayMs = 0): void {
  fake.serve = async (script: FakeScript) => {
    const name = /\/mira-([a-z]+)@[^/]+\.js$/.exec(script.src)?.[1];
    const load = name ? SIBLINGS[name] : undefined;
    await tick(delayMs);
    if (!load) return void script.dispatchEvent(new Event("error"));
    await load();
    script.dispatchEvent(new Event("load"));
  };
}
