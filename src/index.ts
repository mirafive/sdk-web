/**
 * `@mirafive/web`: the npm entry. For the script tag, see `snippet.ts`.
 *
 * ```ts
 * import { createMira } from "@mirafive/web";
 * export const mira = createMira({ key: "pk_live_…" });
 * mira.track("signup_started", { plan: "pro" });
 * ```
 */
import type { Host } from "./consent/types";
import { createMira as createCore, type EventMap, type Mira, type MiraOptions } from "./mira";
import { replayControl } from "./replay/control";

export {
  type AutocaptureOptions,
  type EventMap,
  type SurveyInput,
  type IdentifyOptions,
  type LocationInput,
  type Mira,
  type MiraOptions,
} from "./mira";
export {
  autoConsent,
  borlabs,
  ccm19,
  consentmanager,
  consentMode,
  cookiebot,
  defaultAdapters,
  shopify,
  tcf,
  usercentrics,
  type ConsentAdapter,
  type ConsentChoice,
  type ConsentStatus,
} from "./consent";
export { startShopifyPixel, type ShopifyEvent, type ShopifyPixelInput } from "./shopify/pixel";
export { CART_ATTRIBUTE, shopifyStorefront, VISITOR_COOKIE } from "./shopify/storefront";
export { eventIdFor, uuidv7 } from "@mirafive/protocol";
export { createNoopMira } from "./noop";
export { VERSION } from "./version";

/**
 * Creates an SDK instance. Pass options to start it at once, or call `init` later; calls made
 * before `init` are kept and replayed. `host` is the window, injectable for tests.
 *
 * When the server records the visitor's session and analytics consent is given, the recorder is
 * loaded with a dynamic `import()`, which bundlers split into a chunk of its own: it is not in your
 * main bundle and is never fetched otherwise.
 */
export function createMira<Events extends EventMap = EventMap>(
  options?: MiraOptions,
  host?: Host,
): Mira<Events> {
  return createCore<Events>(
    options,
    host,
    undefined,
    replayControl(() => import("./replay/recorder").then((module) => module.createReplay)),
  );
}
