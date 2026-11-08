/**
 * `@mirafive/web`: the npm entry. For the script tag, see `snippet.ts`.
 *
 * ```ts
 * import { createMira } from "@mirafive/web";
 * export const mira = createMira({ key: "pk_live_…" });
 * mira.track("signup_started", { plan: "pro" });
 * ```
 */
export {
  createMira,
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
  tcf,
  usercentrics,
  type ConsentAdapter,
  type ConsentChoice,
  type ConsentStatus,
} from "./consent";
export { eventIdFor, uuidv7 } from "@mirafive/protocol";
export { createNoopMira } from "./noop";
export { VERSION } from "./version";
