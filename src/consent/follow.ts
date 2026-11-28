import type { ConsentAdapter, ConsentStatus, Host } from "./types";

const POLL_MS = 250;
/** CMPs load asynchronously; after this long without one, we stop looking and stay at T0. */
const GIVE_UP_MS = 15_000;

/**
 * Finds the first CMP on the page and follows it. CMP scripts often load after MIRA, so detection
 * is retried until one appears. Fallback adapters are only tried after the window `load` event.
 * The returned function stops detection and the active subscription.
 */
export function followBanners(
  host: Host,
  emit: (status: ConsentStatus, adapter: string) => void,
  adapters: readonly ConsentAdapter[],
  /** Called once when a banner is detected, before it has said anything (its script may still load). */
  onDetect?: (adapter: ConsentAdapter) => void,
): () => void {
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const started = Date.now();
  const loaded = () => host.document.readyState === "complete";

  const attempt = () => {
    if (stop) return;
    for (const adapter of adapters) {
      if (adapter.fallback && !loaded()) continue;
      let found = false;
      try {
        found = adapter.detect(host);
        if (found) {
          onDetect?.(adapter);
          stop = adapter.subscribe(host, (status) => emit(status, adapter.name));
        }
      } catch {
        // A broken CMP must never break the host page or the SDK; try the next one.
        found = false;
      }
      if (found) break;
    }
    if (stop || Date.now() - started > GIVE_UP_MS) {
      clearInterval(timer);
      host.removeEventListener("load", attempt);
    }
  };

  host.addEventListener("load", attempt);
  timer = setInterval(attempt, POLL_MS);
  attempt();

  return () => {
    clearInterval(timer);
    host.removeEventListener("load", attempt);
    stop?.();
    stop = () => {};
  };
}
