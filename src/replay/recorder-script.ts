/**
 * The recorder as a script, built to `dist/mira-recorder.js` and served beside `mira.js` as
 * `/sdk/mira-recorder@<version>.js`. The script tag of the same release loads it
 * (`script-loader.ts`); it registers under that release's name and does nothing else.
 */
import { VERSION } from "../version";
import { createReplay } from "./recorder";
import { recorderSlot } from "./script-loader";

(globalThis as Record<symbol, unknown>)[recorderSlot(VERSION)] = createReplay;
