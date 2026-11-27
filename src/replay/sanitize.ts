/**
 * The PII guard for what rrweb records outside text: rrweb has no hook for attribute values, so
 * this plugin's `eventProcessor` runs over the full snapshot, added nodes, attribute changes and
 * the page URL of meta events, before an event is kept. It also drops stylesheets that come from a
 * browser extension.
 */
import { EXTENSION_SCHEMES, redact } from "./masking";

/** rrweb's event and node types, as numbers (`@rrweb/types`). */
export const EVENT = { fullSnapshot: 2, incremental: 3, meta: 4, plugin: 6 } as const;
const MUTATION = 0;
const ELEMENT = 2;

/** A recorded event, as far as this file reads it. */
export interface RecordedEvent {
  type: number;
  data: any;
  timestamp: number;
}

interface SerializedNode {
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
  id?: number;
}

/** Finds the live node behind a recorded id (rrweb's mirror). */
export type NodeOf = (id: number) => unknown;

/** Attributes whose values are text a person may have put there. */
const TEXT_ATTRIBUTES = new Set(["title", "alt", "placeholder", "value", "label", "href"]);
const isText = (name: string) =>
  TEXT_ATTRIBUTES.has(name) || name.startsWith("data-") || name.startsWith("aria-");

const fromExtension = (url: unknown) =>
  typeof url === "string" && EXTENSION_SCHEMES.some((scheme) => url.startsWith(scheme));

/** Whether a stylesheet, or one it imports, comes from a browser extension. */
function extensionSheet(sheet: CSSStyleSheet | null | undefined, depth = 0): boolean {
  if (!sheet || depth > 3) return false;
  if (fromExtension(sheet.href)) return true;
  try {
    for (const rule of Array.from(sheet.cssRules)) {
      const imported = (rule as CSSImportRule).styleSheet;
      if (
        imported !== undefined &&
        (fromExtension((rule as CSSImportRule).href) || extensionSheet(imported, depth + 1))
      ) {
        return true;
      }
    }
  } catch {
    // A sheet of another origin cannot be read; rrweb could not inline it either.
  }
  return false;
}

/**
 * A web address without its query or fragment, which can carry tokens and what a person typed
 * (`?email=…`, a reset link). Anything else (a fragment link, a relative path) stays as it is.
 */
export function withoutQuery(value: string): string {
  if (!/^https?:/i.test(value)) return value;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

/** One attribute's value after the guard. */
export function cleanAttribute(name: string, value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  if (name === "action") return redact(withoutQuery(value));
  if (!isText(name)) return value;
  // A mail or phone link is an address and nothing else.
  if (name === "href" && /^\s*(mailto|tel|sms):/i.test(value)) return value.replace(/:.*$/s, ":");
  if (name === "href") return redact(withoutQuery(value));
  return redact(value);
}

function cleanAttributes(
  attributes: Record<string, unknown>,
  id: number | undefined,
  nodeOf: NodeOf,
): void {
  for (const [name, value] of Object.entries(attributes)) {
    const cleaned = cleanAttribute(name, value);
    if (cleaned !== value) attributes[name] = cleaned;
  }
  const css = attributes._cssText;
  if (typeof css !== "string") return;
  const node = id === undefined ? undefined : (nodeOf(id) as { sheet?: CSSStyleSheet } | undefined);
  if (EXTENSION_SCHEMES.some((scheme) => css.includes(scheme)) || extensionSheet(node?.sheet)) {
    attributes._cssText = "";
  }
}

function cleanTree(node: SerializedNode | undefined, nodeOf: NodeOf): void {
  // A loop over a stack: a deep page must not exhaust the call stack.
  const stack = node ? [node] : [];
  while (stack.length) {
    const next = stack.pop()!;
    if (next.type === ELEMENT && next.attributes) cleanAttributes(next.attributes, next.id, nodeOf);
    if (next.childNodes) stack.push(...next.childNodes);
  }
}

/** Cleans one event in place and returns it. */
export function sanitize<T extends RecordedEvent>(event: T, nodeOf: NodeOf): T {
  const { data } = event;
  if (!data) return event;
  if (event.type === EVENT.meta && typeof data.href === "string") {
    data.href = redact(withoutQuery(data.href));
  } else if (event.type === EVENT.fullSnapshot) cleanTree(data.node, nodeOf);
  else if (event.type === EVENT.incremental && data.source === MUTATION) {
    for (const add of data.adds ?? []) cleanTree(add.node, nodeOf);
    for (const change of data.attributes ?? []) {
      if (change.attributes) cleanAttributes(change.attributes, change.id, nodeOf);
    }
  }
  return event;
}
