/**
 * Core Web Vitals for the slow-page signal: Largest Contentful Paint, Interaction to Next Paint
 * and Cumulative Layout Shift, measured the way the web-vitals library measures them, from the
 * browser's own performance entries. Read when the page is hidden or left; a browser without an
 * entry type measures nothing of it.
 */

export interface Vitals {
  lcp?: number;
  inp?: number;
  cls?: number;
}

/** INP: the worst interaction, leaving out one for every 50 (the 98th percentile). */
export function inpOf(durations: readonly number[], interactions: number): number | undefined {
  if (durations.length === 0) return undefined;
  const sorted = durations.toSorted((a, b) => b - a);
  return sorted[Math.min(sorted.length - 1, Math.floor(interactions / 50))];
}

/**
 * CLS: the largest session window of layout shifts not caused by input, a window ending after a
 * second without a shift or after five seconds. `shifts` are `[startTime, value]` in time order.
 */
export function clsOf(shifts: readonly (readonly [number, number])[]): number {
  let largest = 0;
  let windowValue = 0;
  let first = 0;
  let last = 0;
  for (const [at, value] of shifts) {
    if (windowValue > 0 && (at - last > 1_000 || at - first > 5_000)) windowValue = 0;
    if (windowValue === 0) first = at;
    windowValue += value;
    last = at;
    largest = Math.max(largest, windowValue);
  }
  return largest;
}

interface Entry {
  startTime: number;
  duration: number;
  interactionId?: number;
  value?: number;
  hadRecentInput?: boolean;
}

export interface VitalsWatch {
  /** The vitals since the page started; LCP only for the document's first page. */
  take(): Vitals;
  /** An SPA navigation: INP and CLS start over; LCP belongs to the first page only. */
  restart(): void;
}

export function watchVitals(win: typeof globalThis): VitalsWatch {
  const Observer = win.PerformanceObserver;
  const supported: readonly string[] = Observer?.supportedEntryTypes ?? [];
  const activation =
    (
      win.performance?.getEntriesByType?.("navigation")[0] as
        | { activationStart?: number }
        | undefined
    )?.activationStart ?? 0;
  let lcp: number | undefined;
  let firstPage = true;
  // LCP counts only while the page was never hidden: a tab opened in the background paints when
  // it is first shown, which says nothing about how fast the page is (as web-vitals does it).
  let firstHidden = win.document?.visibilityState === "hidden" ? 0 : Infinity;
  try {
    for (const entry of win.performance?.getEntriesByType?.("visibility-state") ?? []) {
      if (entry.name === "hidden") firstHidden = Math.min(firstHidden, entry.startTime);
    }
  } catch {
    // An older browser: the state at this moment and the changes from now on.
  }
  win.document?.addEventListener(
    "visibilitychange",
    () => {
      if (win.document.visibilityState === "hidden") {
        firstHidden = Math.min(firstHidden, win.performance.now());
      }
    },
    { capture: true, passive: true },
  );
  let shifts: [number, number][] = [];
  let interactions = new Map<number, number>();

  const observe = (type: string, take: (entry: Entry) => void, extra: object = {}) => {
    if (!Observer || !supported.includes(type)) return;
    try {
      new Observer((list) => {
        try {
          for (const entry of list.getEntries() as unknown as Entry[]) take(entry);
        } catch {
          // Never in the page's way.
        }
      }).observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
    } catch {
      // An entry type this browser lists but does not observe.
    }
  };
  observe("largest-contentful-paint", (entry) => {
    if (firstPage && entry.startTime < firstHidden) lcp = Math.max(0, entry.startTime - activation);
  });
  observe("layout-shift", (entry) => {
    if (!entry.hadRecentInput && entry.value) shifts.push([entry.startTime, entry.value]);
  });
  observe(
    "event",
    (entry) => {
      if (!entry.interactionId) return;
      interactions.set(
        entry.interactionId,
        Math.max(interactions.get(entry.interactionId) ?? 0, entry.duration),
      );
    },
    { durationThreshold: 40 },
  );

  return {
    take() {
      const count =
        (win.performance as Performance & { interactionCount?: number }).interactionCount ??
        interactions.size;
      const inp = inpOf([...interactions.values()], count);
      const cls = shifts.length > 0 ? clsOf(shifts) : undefined;
      return {
        ...(firstPage && lcp !== undefined ? { lcp: Math.round(lcp) } : {}),
        ...(inp !== undefined ? { inp: Math.round(inp) } : {}),
        ...(cls !== undefined ? { cls: Math.round(cls * 1000) / 1000 } : {}),
      };
    },
    restart() {
      firstPage = false;
      shifts = [];
      interactions = new Map();
    },
  };
}
