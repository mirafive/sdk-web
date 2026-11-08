import type { Host } from "./consent/types";

/**
 * The part of a URL that makes it a different page. The hash is ignored, except for hash routers
 * (`#/route`, `#!/route`), where the hash is the route.
 */
export function pageKey(href: string): string {
  const hashAt = href.indexOf("#");
  if (hashAt === -1) return href;
  const hash = href.slice(hashAt);
  return hash.startsWith("#/") || hash.startsWith("#!") ? href : href.slice(0, hashAt);
}

/** Wait after a navigation before reading the page: routers update the title after they render,
 *  and a redirect (push, then replace) collapses into one pageview. */
const SETTLE_MS = 100;

interface NavigationLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Calls `onNavigate` after each client-side navigation of a single-page app.
 *
 * Prefers the Navigation API (`navigatesuccess` fires once a navigation and its route handler have
 * finished; `currententrychange` also covers `pushState`). Without it, `history.pushState` and
 * `replaceState` are wrapped and `popstate` is watched. Deduplication of same-URL calls is the
 * caller's job, because several of these signals fire for one navigation.
 */
export function watchNavigation(host: Host, onNavigate: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    clearTimeout(timer);
    timer = setTimeout(onNavigate, SETTLE_MS);
  };

  const navigation = host.navigation as NavigationLike | undefined;
  if (navigation?.addEventListener) {
    const events = ["navigatesuccess", "currententrychange"];
    for (const name of events) navigation.addEventListener(name, settle);
    return () => {
      clearTimeout(timer);
      for (const name of events) navigation.removeEventListener(name, settle);
    };
  }

  const history = host.history;
  const methods = ["pushState", "replaceState"] as const;
  const restore = methods.map((name) => {
    const original = history[name];
    const wrapped = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      settle();
      return result;
    };
    history[name] = wrapped;
    return () => {
      // Only unwrap if no other script wrapped it after us; otherwise we would cut their chain.
      if (history[name] === wrapped) history[name] = original;
    };
  });
  host.addEventListener("popstate", settle);
  return () => {
    clearTimeout(timer);
    for (const undo of restore) undo();
    host.removeEventListener("popstate", settle);
  };
}
