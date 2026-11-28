/**
 * What a signal says about an element: a short, stable selector and its visible label, never a
 * field's value. Everything here reads the element only when a signal is reported, not on every
 * click, and never forces a layout (`textContent`, not `innerText`).
 */
import { redactPii, SIGNAL_LIMITS } from "@mirafive/protocol";

export interface ElementLike {
  tagName: string;
  id?: string;
  classList?: Iterable<string>;
  parentElement: ElementLike | null;
  getAttribute(name: string): string | null;
  closest(selector: string): ElementLike | null;
  matches(selector: string): boolean;
  textContent: string | null;
}

/** What looks clickable by what it is; a `cursor: pointer` counts too (`looksClickable`). */
export const CLICKABLE = [
  "a[href]",
  "button",
  "summary",
  "label",
  "select",
  "[onclick]",
  "input[type=button]",
  "input[type=submit]",
  "input[type=reset]",
  "input[type=image]",
  "input[type=checkbox]",
  "input[type=radio]",
  ...["button", "link", "tab", "menuitem", "checkbox", "switch", "option", "radio"].map(
    (role) => `[role=${role}]`,
  ),
].join(",");

/** Where a visitor types or picks: clicking there to place the caret is no frustration. */
export const EDITABLE =
  "input:not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable=''],[contenteditable=true]";

/** Disabled controls do not look clickable. */
const DISABLED = ":disabled,[aria-disabled=true]";

/** Masked like the recording (docs/replay.md, Masking): its text is never sent. */
const MASKED = "[data-mira-mask],[data-mira-block]";

/**
 * The element a click was meant for: the nearest one that looks clickable, or the target itself
 * when the page shows a pointer over it. Undefined when nothing looks clickable or it is disabled.
 */
export function clickableOf(
  target: ElementLike,
  cursorOf: (element: ElementLike) => string,
): ElementLike | undefined {
  const element = target.closest(CLICKABLE) ?? (cursorOf(target) === "pointer" ? target : null);
  if (!element || element.matches(DISABLED)) return undefined;
  return element;
}

/**
 * A name in the page's code that stays put: no long runs of digits, no generated prefixes
 * (`css-1x2y3z`, `sc-…`, `_abc`), at most 40 characters.
 */
export function isStable(name: string): boolean {
  return (
    /^[A-Za-z][\w-]{0,39}$/.test(name) &&
    !/\d{3,}/.test(name) &&
    !/^(css|sc|jsx|svelte|emotion|chakra|tw)-/i.test(name) &&
    !/^[a-z]{1,3}-[a-z0-9]{5,}$/i.test(name)
  );
}

const part = (element: ElementLike) => {
  const tag = element.tagName.toLowerCase();
  if (element.id && isStable(element.id)) return { text: `${tag}#${element.id}`, anchored: true };
  const classes = [...(element.classList ?? [])].filter(isStable).slice(0, 2);
  return { text: [tag, ...classes].join("."), anchored: false };
};

/**
 * A short selector: up to three levels, stopping at a stable id (`form#checkout > button.apply`).
 * Short rather than unique: it names the element for a person and groups the same element across
 * visits.
 */
export function selectorOf(element: ElementLike): string {
  const parts: string[] = [];
  let current: ElementLike | null = element;
  while (current && parts.length < 3) {
    const { text, anchored } = part(current);
    parts.unshift(text);
    if (anchored || text === "body") break;
    current = current.parentElement;
  }
  return redactPii(parts.join(" > "), () => "").text.slice(0, SIGNAL_LIMITS.selectorLength);
}

const collapse = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/**
 * The element's visible label: its `aria-label`, its text, its `title` or an image's `alt`; a
 * button input's `value` is its text. Never another input's value. Empty inside an element the
 * page masks. Passes the PII guard.
 */
export function labelOf(element: ElementLike): string {
  if (element.closest(MASKED)) return "";
  const buttonValue = element.matches("input[type=button],input[type=submit],input[type=reset]")
    ? element.getAttribute("value")
    : null;
  const label =
    collapse(element.getAttribute("aria-label")) ||
    collapse(buttonValue) ||
    (element.matches("input,textarea,select") ? "" : collapse(element.textContent)) ||
    collapse(element.getAttribute("title")) ||
    collapse(element.getAttribute("alt"));
  return redactPii(label.slice(0, 120)).text.slice(0, SIGNAL_LIMITS.textLength);
}

/**
 * A form field by its name in the code (`name`), else by its label (`aria-label`, its `<label>`,
 * its placeholder), else by its `id`; `label` says when it is a label a visitor saw. Never its
 * value.
 */
export function fieldOf(
  field: ElementLike,
  labelFor: (id: string) => ElementLike | null,
): { name: string; label: boolean } {
  const clean = (text: string) =>
    redactPii(text.slice(0, 120)).text.slice(0, SIGNAL_LIMITS.textLength);
  const name = field.getAttribute("name");
  if (name) return { name: clean(name), label: false };
  const label =
    collapse(field.getAttribute("aria-label")) ||
    collapse((field.id ? labelFor(field.id) : null)?.textContent) ||
    collapse(field.closest("label")?.textContent) ||
    collapse(field.getAttribute("placeholder"));
  if (label) return { name: clean(label), label: true };
  return { name: clean(field.id ?? ""), label: false };
}
