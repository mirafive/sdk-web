import { VERSION } from "../version";
import type { CreateReplay, RecorderLoader } from "./control";

/** The recorder file's Subresource Integrity hash, set by the build (build.ts); none in tests. */
declare const MIRA_RECORDER_INTEGRITY: string | undefined;

/** Where the recorder file registers itself: one name per release, so files of two releases never mix. */
export const recorderSlot = (version: string) => Symbol.for(`mirafive.recorder@${version}`);

/**
 * The recorder of this release, next to the script that is running: `/sdk/mira.js`,
 * `/sdk/v2/mira.js` and `/sdk/mira@2.3.0.js` all load `/sdk/mira-recorder@2.3.0.js`, the file that
 * never changes under its version. A first-party proxy forwards it like the script.
 */
export function recorderUrl(scriptSrc: string, version: string = VERSION): string | undefined {
  try {
    const url = new URL(scriptSrc);
    url.pathname = url.pathname.replace(/(?:v\d+\/)?[^/]*$/, `mira-recorder@${version}.js`);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Loads the recorder as a script beside this one, checked by its integrity hash, once. Its errors
 * carry no text: the base script stays small, and the caller says what failed.
 */
export function scriptLoader(scriptSrc: string | undefined, document: Document): RecorderLoader {
  let loading: Promise<CreateReplay> | undefined;
  return () =>
    (loading ??= new Promise<CreateReplay>((resolve, reject) => {
      const url = scriptSrc && recorderUrl(scriptSrc);
      if (!url) return reject();
      const script = document.createElement("script");
      script.src = url;
      script.crossOrigin = "anonymous";
      if (typeof MIRA_RECORDER_INTEGRITY === "string") script.integrity = MIRA_RECORDER_INTEGRITY;
      script.addEventListener("load", () => {
        const create = (globalThis as Record<symbol, CreateReplay | undefined>)[
          recorderSlot(VERSION)
        ];
        if (create) resolve(create);
        else reject();
      });
      script.addEventListener("error", () => reject());
      document.head.append(script);
    }));
}
