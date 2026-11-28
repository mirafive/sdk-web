/**
 * The CMP adapters' subscriptions as a script, built to `dist/mira-consent.js` and served beside
 * `mira.js` as `/sdk/mira-consent@<version>.js`. The script tag of the same release loads it once
 * it has detected a banner (`lazy.ts`); it registers under that release's name and does nothing
 * else.
 */
import { siblingSlot } from "../sibling";
import { VERSION } from "../version";
import { defaultAdapters } from "./auto";
import type { ConsentFile } from "./lazy";

(globalThis as Record<symbol, unknown>)[siblingSlot("consent", VERSION)] = Object.fromEntries(
  defaultAdapters.map((adapter) => [adapter.name, adapter]),
) satisfies ConsentFile;
