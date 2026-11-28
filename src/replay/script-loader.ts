import { siblingLoader, siblingSlot, siblingUrl } from "../sibling";
import { VERSION } from "../version";
import type { CreateReplay, RecorderLoader } from "./control";

/** Where the recorder file registers itself: one name per release, so files of two releases never mix. */
export const recorderSlot = (version: string) => siblingSlot("recorder", version);

/**
 * The recorder of this release, next to the script that is running: `/sdk/mira.js`,
 * `/sdk/v2/mira.js` and `/sdk/mira@2.3.0.js` all load `/sdk/mira-recorder@2.3.0.js`, the file that
 * never changes under its version. A first-party proxy forwards it like the script.
 */
export const recorderUrl = (scriptSrc: string, version: string = VERSION) =>
  siblingUrl(scriptSrc, "recorder", version);

/** Loads the recorder as a script beside this one, checked by its integrity hash, once. */
export const scriptLoader = (scriptSrc: string | undefined, document: Document): RecorderLoader =>
  siblingLoader<CreateReplay>(scriptSrc, document, "recorder");
