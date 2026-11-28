/**
 * Rage clicks and dead clicks, the rules as pure functions (docs/replay.md, Behavior signals). The
 * detector feeds them what it saw; they say what it was.
 */
import type { SignalRules } from "@mirafive/protocol";

/** One click of a burst: where, when (ms), and the page's reaction count when it happened. */
export interface Click {
  x: number;
  y: number;
  at: number;
  /** The reaction counter at the click. */
  reactions: number;
  /** The values of the fields next to it (a quantity stepper), in memory only. */
  fields: string;
}

/** Whether `next` continues the burst that starts with `first` and last clicked at `last`. */
export function continuesBurst(
  first: Click,
  last: Click,
  next: Pick<Click, "x" | "y" | "at">,
  rules: SignalRules["rage"],
): boolean {
  return (
    next.at - last.at <= rules.gapMs &&
    Math.hypot(next.x - first.x, next.y - first.y) <= rules.radiusPx
  );
}

/**
 * How many clicks of a finished burst the page answered: a click is answered when something
 * happened before the next click (or, for the last, before the burst ended), or the fields next
 * to it changed. `reactionsAtEnd` is the counter when the burst ended.
 */
export function answeredClicks(
  clicks: readonly Click[],
  reactionsAtEnd: number,
  fieldsAtEnd: string,
): number {
  let answered = 0;
  clicks.forEach((click, index) => {
    const next = clicks[index + 1];
    const reactions = next ? next.reactions : reactionsAtEnd;
    const fields = next ? next.fields : fieldsAtEnd;
    if (reactions > click.reactions || fields !== click.fields) answered += 1;
  });
  return answered;
}

/**
 * A rage click: enough fast clicks on one spot, of which the page answered at most one. A carousel
 * moving on every click, a quantity going up, a double or triple click selecting text: all are
 * answered, so none is rage.
 */
export function isRage(
  clicks: readonly Click[],
  reactionsAtEnd: number,
  fieldsAtEnd: string,
  rules: SignalRules["rage"],
): boolean {
  return clicks.length >= rules.clicks && answeredClicks(clicks, reactionsAtEnd, fieldsAtEnd) <= 1;
}

/**
 * Whether a click on a link leaves the page by itself: an `http(s)` URL to another page (or a new
 * tab, a download) whose default the page did not prevent. Such a click is never dead, however
 * long the next page takes.
 */
export function leavesByLink(href: string | null, base: string, prevented: boolean): boolean {
  // `#` and `#section` stay on the page: a scroll (a reaction of its own) or nothing.
  if (prevented || !href || href.startsWith("#")) return false;
  try {
    const url = new URL(href, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const here = new URL(base);
    // `#section` on the same page scrolls (a reaction of its own) or does nothing.
    return !(
      url.hash &&
      url.origin + url.pathname + url.search === here.origin + here.pathname + here.search
    );
  } catch {
    return false;
  }
}
