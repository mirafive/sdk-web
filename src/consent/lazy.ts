/**
 * The script tag's CMP adapters: each one's detection is in `mira.js`, its subscription in the
 * consent file of the same release (`consent-script.ts`), which loads only once a banner is
 * detected. A page without one of these banners never fetches it.
 */
import { detectBorlabs } from "./borlabs";
import { detectCcm19 } from "./ccm19";
import { detectConsentMode } from "./consent-mode";
import { detectConsentmanager } from "./consentmanager";
import { detectCookiebot } from "./cookiebot";
import { detectTcf } from "./tcf";
import type { ConsentAdapter, Host } from "./types";
import { detectUsercentrics } from "./usercentrics";

/** The consent file's adapters, by name. */
export type ConsentFile = Readonly<Record<string, ConsentAdapter>>;

/**
 * An adapter that detects here and subscribes with the consent file's adapter of the same name,
 * once the file is there. Until then the consent stays what it was, as while the banner's own
 * script loads; a file that cannot be loaded leaves it there, so nothing is stored.
 */
export function lazyAdapter(
  name: string,
  detect: (host: Host) => boolean,
  load: () => Promise<ConsentFile>,
  fallback?: true,
): ConsentAdapter {
  return {
    name,
    fallback,
    detect,
    subscribe(host, emit) {
      let stop: (() => void) | undefined;
      let live = true;
      load()
        .then((file) => {
          if (live) stop = file[name]?.subscribe(host, emit);
        })
        // A broken CMP or a missing file must never break the host page or the SDK.
        .catch(() => {});
      return () => {
        live = false;
        stop?.();
      };
    },
  };
}

/** `defaultAdapters`, in the same order, each subscribing from the consent file. */
export const lazyAdapters = (load: () => Promise<ConsentFile>): ConsentAdapter[] => [
  lazyAdapter("usercentrics", detectUsercentrics, load),
  lazyAdapter("cookiebot", detectCookiebot, load),
  lazyAdapter("consentmanager", detectConsentmanager, load),
  lazyAdapter("ccm19", detectCcm19, load),
  lazyAdapter("borlabs", detectBorlabs, load),
  lazyAdapter("tcf", detectTcf, load),
  lazyAdapter("consent-mode", detectConsentMode, load, true),
];
