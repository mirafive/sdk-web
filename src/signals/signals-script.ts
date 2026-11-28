/**
 * The signals detector as a script, built to `dist/mira-signals.js` and served beside `mira.js` as
 * `/sdk/mira-signals@<version>.js`. The script tag of the same release loads it (`sibling.ts`);
 * it registers under that release's name and does nothing else.
 */
import { siblingSlot } from "../sibling";
import { VERSION } from "../version";
import { createSignals } from "./detector";

(globalThis as Record<symbol, unknown>)[siblingSlot("signals", VERSION)] = createSignals;
