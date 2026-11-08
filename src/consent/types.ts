import type { ConsentState } from "@mirafive/protocol";

/** The consent the SDK works with: one state per purpose (docs/consent.md). */
export interface ConsentStatus {
  analytics: ConsentState;
  marketing: ConsentState;
}

/** What the host page may pass: plain booleans for custom banners, or the wire states. */
export interface ConsentChoice {
  analytics: boolean | ConsentState;
  marketing?: boolean | ConsentState;
}

/** The window as the adapters see it: any CMP global may or may not be there. */
export type Host = Window & typeof globalThis & Record<string, unknown>;

/**
 * One consent banner (CMP). Each adapter lives in its own module so a bundler drops the ones
 * that a site does not import.
 */
export interface ConsentAdapter {
  readonly name: string;
  /**
   * Fallback adapters (Google Consent Mode) are only used once the page has loaded and no real
   * CMP showed up. Many CMPs write Consent Mode defaults early, so trying it first would hide
   * the CMP's own, richer signal.
   */
  readonly fallback?: boolean;
  /** True when this CMP is on the page (its global or stub exists). Must be cheap and never throw. */
  detect(host: Host): boolean;
  /**
   * Reports the current state once it is known, then every change. Reports `unknown` while the
   * banner waits for an answer. Returns a function that stops listening.
   */
  subscribe(host: Host, emit: (status: ConsentStatus) => void): () => void;
}

export const UNKNOWN: ConsentStatus = { analytics: "unknown", marketing: "unknown" };

export const state = (value: boolean | ConsentState | undefined): ConsentState =>
  value === true ? "granted" : value === false ? "denied" : (value ?? "unknown");

export function fromChoice(choice: ConsentChoice): ConsentStatus {
  return { analytics: state(choice.analytics), marketing: state(choice.marketing) };
}

export const sameStatus = (a: ConsentStatus, b: ConsentStatus) =>
  a.analytics === b.analytics && a.marketing === b.marketing;

/** The service name customers give MIRA inside their CMP (docs/consent.md, Listing). */
export const MIRA_SERVICE = /mira\s*five/i;

/**
 * Adds a window event listener and returns its remover. Adapters use it so that `subscribe`
 * can always clean up after itself.
 */
export function listen(host: Host, names: string[], handler: (event: Event) => void): () => void {
  for (const name of names) host.addEventListener(name, handler);
  return () => {
    for (const name of names) host.removeEventListener(name, handler);
  };
}
