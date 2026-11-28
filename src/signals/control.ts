/**
 * Behavior signals, the part in the base script: only a loader. When a batch's `202` carries the
 * `signals` field (the project detects them), it loads the detector file, which does everything
 * else (`detector.ts`), and hands it every answer and every page hide from then on.
 */
import type { Host } from "../consent/types";

/** What the detector needs from the page's SDK instance. */
export interface SignalsEnvironment {
  host: Host;
  /** Whether the visitor gave analytics consent (for a `signals.consent` of `analytics`). */
  analytics(): boolean;
  /** Sends a signal as a `track` event; `url`: the page it happened on, if not the current one. */
  track(name: string, properties: Record<string, string | number>, url?: string): void;
}

export interface Signals {
  /** The body of a batch's `202`. */
  answer(body: unknown): void;
  /** The page is hidden; truthy when it is left (`pagehide`). */
  hide(left?: unknown): void;
}

export type CreateSignals = (environment: SignalsEnvironment) => Signals;
export type SignalsFactory = (environment: SignalsEnvironment) => Signals;

/** The control for a page, with the loader of its detector file. */
export const signalsControl =
  (load: () => Promise<CreateSignals>): SignalsFactory =>
  (environment) => {
    let full: Signals | undefined;
    let loading: unknown;
    return {
      answer: (body) =>
        full
          ? full.answer(body)
          : (loading ||=
              (body as { signals?: unknown } | null)?.signals &&
              load().then(
                (create) => (full = create(environment)).answer(body),
                () => {},
              )),
      hide: (left) => full?.hide(left),
    };
  };
