/**
 * What the recorder masks, and the rrweb options that do it (docs/replay.md, Masking in the MIRA FIVE
 * repository). Masked by default; what is masked never leaves the device.
 */
import { matchesAnyPage, redactPii, type ReplayAnswer } from "@mirafive/protocol";

/** Stylesheets a visitor's browser extensions put into the page: not the site, and often megabytes. */
export const EXTENSION_SCHEMES = ["chrome-extension:", "moz-extension:", "safari-web-extension:"];

/**
 * Replaced by a placeholder of the same size: no content, no length, no input events. Passwords,
 * payment fields and one-time codes are here, so no setting can unmask them; rrweb itself knows
 * nothing of `autocomplete`. A password field shown as text keeps its `autocomplete`.
 */
export const BLOCK_SELECTOR = [
  "[data-mira-block]",
  "input[type=password]",
  '[autocomplete^="cc-"]',
  '[autocomplete="one-time-code"]',
  '[autocomplete="current-password"]',
  '[autocomplete="new-password"]',
  ...EXTENSION_SCHEMES.map((scheme) => `link[href^="${scheme}"]`),
].join(",");

/** Every input type and form element, `hidden` included: `maskAllInputs` would leave `hidden` out. */
export const MASKED_INPUTS = {
  color: true,
  date: true,
  "datetime-local": true,
  email: true,
  hidden: true,
  month: true,
  number: true,
  password: true,
  range: true,
  search: true,
  tel: true,
  text: true,
  time: true,
  url: true,
  week: true,
  textarea: true,
  select: true,
} as const;

/** A masked input shows this, whatever its length; an empty one stays empty. */
export const INPUT_MASK = "***";

export const maskInput = (value: string) => (value ? INPUT_MASK : "");

/** Masked text keeps its shape (the page's layout), never its characters. */
const shape = (text: string) => text.replace(/\S/g, "*");
const blank = (_kind: unknown, match: string) => "*".repeat(match.length);

/** A page's settings as the recorder applies them; replaced when a later batch brings new ones. */
export interface Masking {
  answer: ReplayAnswer;
  /** The page's path now (`location.pathname`): sensitive pages are looked up on every text. */
  path(): string;
}

/** Whether all text of the page at `path` is masked: strict mode, or a sensitive page. */
export const masksAllText = (answer: ReplayAnswer, path: string) =>
  answer.masking === "strict" || matchesAnyPage(answer.sensitive, path);

/** Whether the page at `path` is never recorded. */
export const neverRecorded = (answer: ReplayAnswer, path: string) =>
  matchesAnyPage(answer.never_record, path);

/** Where an element sits, as far as masking cares. */
interface MaskedElement {
  tagName?: string;
  closest?(selector: string): unknown;
}

/**
 * rrweb's text hook. With `maskTextSelector: "*"` every text passes here: inside `data-mira-mask`,
 * on a sensitive page and in strict mode it is masked; everything else goes through the PII guard.
 * A `<textarea>`'s text is its value, so it is masked like an input.
 */
export function maskText(masking: Masking, text: string, element: MaskedElement | null): string {
  if (!text.trim()) return text;
  if (element?.tagName === "TEXTAREA") return INPUT_MASK;
  if (masksAllText(masking.answer, masking.path())) return shape(text);
  try {
    if (element?.closest?.("[data-mira-mask]")) return shape(text);
  } catch {
    return shape(text);
  }
  return redactPii(text, blank).text;
}

/** The PII guard for one value (attributes, URLs, error messages). */
export const redact = (value: string) => redactPii(value, blank).text;

/**
 * Every option of rrweb's `record` that decides what is recorded, set here rather than left to
 * rrweb's defaults (`masking.test.ts` pins those defaults too, so a release of rrweb that changes
 * one fails the build).
 */
export function recordOptions(masking: Masking) {
  return {
    blockClass: "rr-block",
    blockSelector: BLOCK_SELECTOR,
    ignoreClass: "rr-ignore",
    ignoreSelector: "[data-mira-ignore]",
    maskTextClass: "rr-mask",
    maskTextSelector: "*",
    maskTextFn: (text: string, element: HTMLElement | null) => maskText(masking, text, element),
    // Off: `maskAllInputs` replaces `maskInputOptions` and leaves `type="hidden"` unmasked.
    maskAllInputs: false,
    maskInputOptions: { ...MASKED_INPUTS },
    maskInputFn: maskInput,
    inlineStylesheet: true,
    inlineImages: false,
    recordCanvas: false,
    collectFonts: false,
    recordCrossOriginIframes: false,
    // Every frame's `src` is dropped: the player never loads another site.
    keepIframeSrcFn: () => false,
    slimDOMOptions: {},
    sampling: { mousemove: 50 },
    userTriggeredOnInput: false,
    // No periodic full snapshot: a new one is taken when the server asks for it (400, 413).
    checkoutEveryNms: undefined,
    checkoutEveryNth: undefined,
    recordAfter: "DOMContentLoaded",
  } as const;
}
