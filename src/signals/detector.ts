/**
 * The behavior signals detector (docs/replay.md, Behavior signals, in the MIRA FIVE repository):
 * rage clicks, dead clicks, abandoned forms, errors and slow pages, sent as ordinary events. A file
 * of its own, loaded only when the server says the project detects signals (`control.ts`).
 *
 * - The numbers come from the server's answer (`signals.rules`), else `SIGNAL_RULES`.
 * - Signals are about the page and read nothing from the device: nothing here touches cookies or
 *   storage. With `signals.consent` `analytics`, nothing is detected before analytics consent.
 * - On a page the project marks sensitive, in strict masking and inside `data-mira-mask`, no
 *   label or message is sent. Never a field's value, never a request's query, body or headers.
 * - Never in the page's way: passive listeners, the work done after the click, not during it,
 *   every error swallowed, at most `SIGNAL_LIMITS` per page view and per document.
 */
import {
  matchesAnyPage,
  readSignalsAnswer,
  redactPii,
  SIGNAL_LIMITS,
  SIGNAL_RULES,
  type SignalEvent,
  type SignalRules,
  type SignalsAnswer,
} from "@mirafive/protocol";

import { watchNavigation } from "../autocapture";
import { continuesBurst, isRage, leavesByLink, type Click } from "./clicks";
import type { CreateSignals, SignalsEnvironment } from "./control";
import { clickableOf, EDITABLE, fieldOf, labelOf, selectorOf, type ElementLike } from "./element";
import { watchProblems, type Problem } from "./problems";
import { watchVitals } from "./vitals";

type Properties = Record<string, string | number>;

/** Forms whose fields were touched and that were not sent, per form. */
interface Started {
  form: ElementLike & { isConnected?: boolean };
  field: { name: string; label: boolean };
  fields: Set<string>;
  first: number;
  /** The request counter at the last touch: a request after it counts as sent. */
  requests: number;
}

const DEFAULT_RULES: SignalRules = {
  rage: { ...SIGNAL_RULES.rage },
  dead: { ...SIGNAL_RULES.dead },
  slow: { ...SIGNAL_RULES.slow },
};

/** Fields next to a clicked element, as one string: a quantity stepper changes them. */
function fieldsNear(target: Element): string {
  const box = target.closest("form,[role=group],fieldset") ?? target.parentElement?.parentElement;
  if (!box) return "";
  const fields = box.querySelectorAll("input:not([type=hidden]),select");
  if (fields.length > 10) return "";
  let values = "";
  for (const field of fields) values += `${(field as HTMLInputElement).value}\u0000`;
  return values;
}

export const createSignals: CreateSignals = (environment: SignalsEnvironment) => {
  const { host } = environment;
  const win = host as unknown as typeof globalThis & Window;
  const document = win.document;
  let answer: SignalsAnswer | undefined;
  let rules = DEFAULT_RULES;
  let started = false;
  let leaving = false;
  /** Anything the page did that a click could have caused. */
  let reactions = 0;
  /** Requests the page started. */
  let requests = 0;
  /** The page view's URL and its caps, and the document's. */
  let pageUrl = win.location.href;
  let pageCount = 0;
  let documentCount = 0;
  let kinds = new Map<string, number>();
  let seen = new Set<string>();
  let slowSent = false;
  let forms = new Map<ElementLike, Started>();
  const vitals = watchVitals(win);

  const guard =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      try {
        action(...args);
      } catch {
        // Never in the page's way.
      }
    };
  const react = () => {
    reactions += 1;
  };

  const masked = () => {
    if (!answer) return true;
    if (answer.masking === "strict") return true;
    try {
      return matchesAnyPage(answer.sensitive, new URL(pageUrl).pathname);
    } catch {
      return true;
    }
  };
  const allowed = () =>
    answer !== undefined && (answer.consent === "none" || environment.analytics());

  /**
   * Sends a signal, within the caps; `key` sends one of a kind once per page (an error in a loop).
   * Text a visitor saw is left out on a masked page.
   */
  const emit = (name: SignalEvent, properties: Properties, key?: string) => {
    if (!allowed()) return;
    const ofKind = kinds.get(name) ?? 0;
    if (
      ofKind >= SIGNAL_LIMITS.perKind ||
      pageCount >= SIGNAL_LIMITS.perPage ||
      documentCount >= SIGNAL_LIMITS.perDocument
    ) {
      return;
    }
    if (key !== undefined) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    kinds.set(name, ofKind + 1);
    pageCount += 1;
    documentCount += 1;
    const sent: Properties = {};
    const hide = masked();
    for (const [property, value] of Object.entries(properties)) {
      if (value === "" || (hide && (property === "label" || property === "message"))) continue;
      sent[property] = value;
    }
    environment.track(name, sent, pageUrl === win.location.href ? undefined : pageUrl);
  };

  // Clicks ------------------------------------------------------------------------------------

  let burst: Click[] = [];
  let burstTarget: Element | undefined;
  let burstTimer: ReturnType<typeof setTimeout> | undefined;
  let watching = 0;
  let observer: MutationObserver | undefined;

  /** Changes in the page count only while a click waits for its answer. */
  const watchChanges = (on: boolean) => {
    watching += on ? 1 : -1;
    if (watching > 0 && !observer && win.MutationObserver) {
      observer = new win.MutationObserver(react);
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    } else if (watching <= 0 && observer) {
      observer.disconnect();
      observer = undefined;
      watching = 0;
    }
  };

  const element = (target: Element) =>
    clickableOf(target as unknown as ElementLike, (el) => {
      try {
        return win.getComputedStyle(el as unknown as Element).cursor;
      } catch {
        return "";
      }
    });

  const endBurst = guard(() => {
    const clicks = burst;
    const target = burstTarget;
    burst = [];
    burstTarget = undefined;
    watchChanges(false);
    if (!target || clicks.length < rules.rage.clicks) return;
    const selected = win.getSelection?.()?.toString() ?? "";
    if (selected.trim() !== "") return;
    if (!isRage(clicks, reactions, fieldsNear(target), rules.rage)) return;
    const clicked = (element(target) ?? target) as unknown as ElementLike;
    emit("$rage_click", {
      selector: selectorOf(clicked),
      label: labelOf(clicked),
      clicks: clicks.length,
    });
  });

  const onClick = guard((event: MouseEvent) => {
    if (!allowed() || !event.isTrusted || leaving) return;
    const target = event.target as Element | null;
    if (!target?.closest || target.closest(EDITABLE)) return;
    const click: Click = {
      x: event.clientX,
      y: event.clientY,
      at: event.timeStamp,
      reactions,
      fields: fieldsNear(target),
    };

    // Rage: the burst goes on or a new one starts.
    const first = burst[0];
    const last = burst.at(-1);
    if (first && last && continuesBurst(first, last, click, rules.rage)) burst.push(click);
    else {
      if (burst.length > 0) {
        clearTimeout(burstTimer);
        endBurst();
      }
      burst = [click];
      burstTarget = target;
      watchChanges(true);
    }
    clearTimeout(burstTimer);
    burstTimer = setTimeout(endBurst, rules.rage.gapMs);

    // Dead: something that looks clickable, and nothing happens for a while.
    const clicked = element(target);
    if (!clicked) return;
    const link = clicked.closest("a[href]");
    const before = { reactions, requests, fields: click.fields, url: win.location.href };
    watchChanges(true);
    setTimeout(
      guard(() => {
        watchChanges(false);
        if (leaving || !allowed()) return;
        if (link && leavesByLink(link.getAttribute("href"), before.url, event.defaultPrevented))
          return;
        if (reactions !== before.reactions || requests !== before.requests) return;
        if (win.location.href !== before.url || fieldsNear(target) !== before.fields) return;
        emit("$dead_click", { selector: selectorOf(clicked), label: labelOf(clicked) });
      }),
      rules.dead.waitMs,
    );
  });

  // Forms -------------------------------------------------------------------------------------

  const onInput = guard((event: Event) => {
    react();
    if (!event.isTrusted) return;
    const field = event.target as (Element & { type?: string }) | null;
    const form = field?.closest?.("form") as unknown as ElementLike | null;
    if (!field || !form || field.type === "hidden" || field.type === "search") return;
    if (form.matches("[role=search]")) return;
    const name = fieldOf(
      field as unknown as ElementLike,
      (id) =>
        document.querySelector(`label[for="${CSS.escape(id)}"]`) as unknown as ElementLike | null,
    );
    const entry = forms.get(form) ?? {
      form,
      field: name,
      fields: new Set<string>(),
      first: Date.now(),
      requests,
    };
    entry.field = name;
    entry.fields.add(name.name);
    entry.requests = requests;
    forms.set(form, entry);
  });

  const onSubmit = guard((event: Event) => {
    react();
    forms.delete(event.target as unknown as ElementLike);
  });

  /** Forms started and left: not sent, no request after their last touch, still on the page. */
  const abandoned = (spa: boolean) => {
    for (const entry of forms.values()) {
      if (entry.requests !== requests) continue;
      if (!spa && entry.form.isConnected === false) continue;
      const hide = masked() && entry.field.label;
      emit("$form_abandon", {
        form: selectorOf(entry.form),
        form_id: redactPii(entry.form.getAttribute("id") ?? "", () => "").text.slice(0, 120),
        form_name: redactPii(entry.form.getAttribute("name") ?? "", () => "").text.slice(0, 120),
        field: hide ? "" : entry.field.name,
        fields: entry.fields.size,
        ms: Math.max(0, Date.now() - entry.first),
      });
    }
    forms = new Map();
  };

  // Slow pages and the page's end ---------------------------------------------------------------

  const slow = () => {
    if (slowSent) return;
    slowSent = true;
    const { lcp, inp, cls } = vitals.take();
    const poor = [
      lcp !== undefined && lcp > rules.slow.lcpMs ? "lcp" : "",
      inp !== undefined && inp > rules.slow.inpMs ? "inp" : "",
      cls !== undefined && cls > rules.slow.cls ? "cls" : "",
    ].filter(Boolean);
    if (poor.length === 0) return;
    emit("$slow_page", {
      ...(lcp !== undefined ? { lcp_ms: lcp } : {}),
      ...(inp !== undefined ? { inp_ms: inp } : {}),
      ...(cls !== undefined ? { cls } : {}),
      poor: poor.join(","),
    });
  };

  /** An SPA navigation: the old page's slow vitals and forms, then fresh caps for the new one. */
  const navigated = guard(() => {
    react();
    if (pageUrl === win.location.href) return;
    slow();
    abandoned(true);
    vitals.restart();
    pageUrl = win.location.href;
    pageCount = 0;
    kinds = new Map();
    seen = new Set();
    slowSent = false;
  });

  const start = () => {
    if (started) return;
    started = true;
    const options = { capture: true, passive: true };
    document.addEventListener("click", onClick as EventListener, options);
    for (const name of ["input", "change"]) document.addEventListener(name, onInput, options);
    document.addEventListener("submit", onSubmit, options);
    // What a click can cause, beyond a change in the page: a field taking focus (not the clicked
    // button itself), scrolling, text selected (not the caret a click places), media, a details
    // element opening, a new tab or window, a navigation.
    document.addEventListener(
      "focusin",
      guard((event: Event) => {
        if ((event.target as Element | null)?.closest?.(EDITABLE)) react();
      }),
      options,
    );
    document.addEventListener(
      "selectionchange",
      guard(() => {
        if (win.getSelection?.()?.isCollapsed === false) react();
      }),
      options,
    );
    for (const name of ["scroll", "play", "pause", "toggle"]) {
      document.addEventListener(name, react, options);
    }
    for (const name of ["hashchange", "popstate"]) win.addEventListener(name, react, options);
    win.addEventListener(
      "blur",
      guard((event: Event) => {
        if (event.target === win) react();
      }),
      options,
    );
    watchNavigation(host, navigated);
    // The SDK's own requests go through the `fetch` it bound before this file loaded: they never
    // pass the patch, so nothing here needs to tell them apart.
    watchProblems(
      win,
      (problem: Problem) =>
        emit(
          "$error",
          { ...problem },
          `${problem.kind}\u0000${problem.message}\u0000${problem.source ?? ""}`,
        ),
      () => {
        requests += 1;
      },
    );
  };

  return {
    answer: guard((body: unknown) => {
      const next = readSignalsAnswer(body);
      // An answer that stored events and carries no field: the project turned signals off.
      if (!next) {
        if (((body as { accepted?: number } | null)?.accepted ?? 0) > 0) answer = undefined;
        return;
      }
      answer = next;
      rules = next.rules;
      if (allowed()) start();
    }),
    hide: guard((left: unknown) => {
      react();
      if (!started) return;
      slow();
      if (!left) return;
      leaving = true;
      abandoned(false);
    }),
  };
};
