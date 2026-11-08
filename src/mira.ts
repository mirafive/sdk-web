import {
  cleanExternalIds,
  cleanProperties,
  DEFAULT_HOST,
  keyKind,
  LIMITS,
  touchpointChannels,
  trimHost,
  uuidv7,
  type ExternalIdType,
  type TouchpointChannel,
  type WireEvent,
} from "@mirafive/protocol";

import { pageKey, watchNavigation } from "./autocapture";
import { watchEngagement, watchInteractions, type Engagement } from "./behavior";
import { autoConsent, defaultAdapters } from "./consent/auto";
import {
  fromChoice,
  sameStatus,
  UNKNOWN,
  type ConsentAdapter,
  type ConsentChoice,
  type ConsentStatus,
  type Host,
} from "./consent/types";
import { buildContext, readClientHints, type ClientHints, type PageInfo } from "./context";
import { createStore, KEYS } from "./storage";
import { Transport, type QueuedEvent } from "./transport";

/**
 * Your events and their properties, for autocomplete and type checks:
 * `createMira<{ signup_started: { plan: "free" | "pro" } }>({ key })`.
 */
export type EventMap = Record<string, Record<string, unknown> | undefined>;

export interface MiraOptions {
  /** The project's public key (`mira_pk_…`). Never a secret key: those stay on your server. */
  key: string;
  /** Ingest origin. Default `https://events.mirafive.io`. */
  host?: string;
  /** `'auto'` follows the CMP on the page (default); an object sets the state for custom banners. */
  consent?: "auto" | ConsentChoice;
  /** What the SDK captures on its own; all on by default. `false` turns everything off. */
  autocapture?: boolean | AutocaptureOptions;
  /** The CMP adapters `'auto'` tries, in order. Pass a subset to keep the bundle small. */
  adapters?: readonly ConsentAdapter[];
  /** Logs dropped events and failed batches to the console. */
  debug?: boolean;
}

export interface AutocaptureOptions {
  /** A pageview on load. */
  pageviews?: boolean;
  /** A pageview on each client-side navigation. */
  spa?: boolean;
  /** `$engagement` when the person leaves a page: engaged time and scroll depth. */
  engagement?: boolean;
  /** `$outbound_click` for links to other sites. */
  outbound?: boolean;
  /** `$file_download` for links to files (PDF, ZIP, …) and links with a `download` attribute. */
  downloads?: boolean;
  /** `$form_submit` with the form's id, name and action path. Never field values. */
  forms?: boolean;
}

export interface IdentifyOptions {
  /** The person's ids in other systems, so connectors can link their money to this user. */
  externalIds?: Partial<Record<ExternalIdType, string>>;
}

/**
 * The answer to "How did you hear about us?", as a touchpoint the attribution models credit like
 * a visit. Needs a `channel` or a `source`.
 */
export interface SurveyInput {
  /** Where the person says they came from: `podcast`, `friend`, `instagram`. */
  source?: string;
  /** One of MIRA FIVE's channels, when your form maps answers to channels. */
  channel?: TouchpointChannel;
  medium?: string;
  campaign?: string;
  /** The answer as the person gave it, for example free text. It passes MIRA FIVE's PII guard. */
  answer?: string;
  properties?: Record<string, unknown>;
}

/** A location the site already has, for example from a "near me" search. */
export interface LocationInput {
  latitude: number;
  longitude: number;
}

export interface Mira<Events extends EventMap = EventMap> {
  init(options: MiraOptions): void;
  /** A manual pageview, for example `{ status: 404 }` on your not-found page. */
  page(properties?: Record<string, unknown>): void;
  /** A custom event. Names starting with `$` are reserved for MIRA FIVE. */
  track<Name extends keyof Events & string>(name: Name, properties?: Events[Name]): void;
  /** A survey answer ("How did you hear about us?") as a touchpoint. */
  survey(input: SurveyInput): void;
  identify(userId: string, traits?: Record<string, unknown>, options?: IdentifyOptions): void;
  group(groupId: string, traits?: Record<string, unknown>): void;
  consent(choice: "auto" | ConsentChoice): void;
  /**
   * A location the site already has (never one the SDK asks the browser for). Kept in memory and
   * sent only with analytics consent, rounded to 2 decimals (about 1 km). `null` forgets it.
   */
  setLocation(location: LocationInput | null): void;
  reset(): void;
  flush(): Promise<void>;
  /** The consent the SDK currently works with (after Global Privacy Control). */
  readonly status: ConsentStatus;
  /**
   * This visitor's anonymous id, only with analytics consent (else `undefined`). Pass it to your
   * server, so server events (`@mirafive/node`, `anonymousId`) join this visitor's journey.
   */
  readonly anonymousId: string | undefined;
}

/** How long the first automatic pageview waits for the CMP, so a returning visitor's pageview
 *  already carries their consent instead of a T0 pageview plus a `$consent_changed`. */
const CONSENT_WAIT_MS = 1_000;

/** User and group ids: strings or numbers from the host page, at most 200 characters on the wire. */
const idOf = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value).slice(0, 200) : "";
const PERSIST_DELAY_MS = 500;
/** About 1 km, as the ingest keeps it (docs/data-collection.md, 2. Location). */
const twoDecimals = (degrees: number) => Math.round(degrees * 100) / 100;
/** A page left within a second was not read; its `$engagement` would only be noise. */
const MIN_ENGAGED_MS = 1_000;

/**
 * Creates an SDK instance. Pass options to start it at once, or call `init` later; calls made
 * before `init` are kept and replayed. `host` is the window, injectable for tests.
 */
export function createMira<Events extends EventMap = EventMap>(
  options?: MiraOptions,
  host: Host = globalThis as unknown as Host,
): Mira<Events> {
  let started = false;
  let debug = false;
  const early: (() => void)[] = [];
  let transport: Transport | undefined;

  let status: ConsentStatus = UNKNOWN;
  let anonymousId: string | undefined;
  let userId: string | undefined;
  let groupId: string | undefined;
  /** An `identify` made before consent (traits, external ids); sent once analytics consent arrives. */
  let pendingIdentify: Partial<WireEvent> | undefined;
  let location: LocationInput | undefined;
  /** Whether this page already sent something without consent (so a cookieless session exists to carry over). */
  let sentWithoutConsent = false;
  let page: PageInfo = { url: "", referrer: "" };
  let lastPageKey = "";
  let stopAuto: (() => void) | undefined;
  let adapters = defaultAdapters;
  let onFirstConsent: (() => void) | undefined;
  /** Client hints, read once per analytics grant and kept in memory only. */
  let hints: ClientHints | undefined;
  let hintsAsked = false;
  let engagement: Engagement | undefined;

  const store = createStore(() => host.localStorage);
  const analytics = () => status.analytics === "granted";
  const warn = (message: string, error?: unknown) => {
    if (debug) console.warn(`MIRA FIVE: ${message}`, error ?? "");
  };

  /** Every public method goes through here: the SDK must never throw into the host page. */
  const guard =
    <A extends unknown[]>(name: string, action: (...args: A) => void) =>
    (...args: A) => {
      try {
        if (!started && name !== "init" && name !== "consent") {
          early.push(() => action(...args));
          return;
        }
        action(...args);
      } catch (error) {
        warn(`${name} failed`, error);
      }
    };

  // Persisting the queue is batched: serialising up to 1000 events on every call would cost
  // main-thread time for nothing.
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let persistNext: QueuedEvent[] = [];
  const persist = (events: QueuedEvent[]) => {
    if (!store.open) return;
    persistNext = events;
    persistTimer ??= setTimeout(() => {
      persistTimer = undefined;
      store.set(KEYS.queue, persistNext.length ? JSON.stringify(persistNext) : undefined);
    }, PERSIST_DELAY_MS);
  };
  const persistNow = () => {
    if (persistTimer === undefined) return;
    clearTimeout(persistTimer);
    persistTimer = undefined;
    store.set(KEYS.queue, persistNext.length ? JSON.stringify(persistNext) : undefined);
  };

  function enqueue(
    type: WireEvent["type"],
    event: string,
    extra: Partial<WireEvent> = {},
    at: PageInfo = pageNow(),
  ) {
    if (!transport) return;
    const consented = analytics();
    const queued: QueuedEvent = {
      event_id: uuidv7(),
      type,
      event,
      timestamp: new Date().toISOString(),
      properties: extra.properties ?? {},
      context: buildContext(host, at, consented ? { hints, location } : undefined),
      consent: { ...status },
    };
    // Identifiers only with analytics consent (docs/integrity.md, guarantee 7).
    if (consented) {
      if (anonymousId) queued.anonymous_id = anonymousId;
      if (userId) queued.user_id = userId;
      if (groupId) queued.group_id = groupId;
    } else {
      sentWithoutConsent = true;
    }
    if (extra.traits) queued.traits = extra.traits;
    if (extra.external_ids) queued.external_ids = extra.external_ids;
    transport.enqueue(queued);
  }

  /**
   * The page an event happens on. Its referrer is the document referrer for the first page, and
   * the previous page's URL after an SPA navigation.
   */
  function pageNow(): PageInfo {
    const url = host.location.href;
    if (!page.url) return { url, referrer: host.document.referrer };
    return { url, referrer: pageKey(url) === lastPageKey ? page.referrer : page.url };
  }

  function advancePage() {
    page = { ...pageNow(), title: host.document.title };
    lastPageKey = pageKey(page.url);
  }

  function capturePage(properties?: Record<string, unknown>) {
    reportEngagement(false);
    advancePage();
    enqueue("page", "$pageview", { properties: cleanProperties(properties) });
    engagement?.restart();
  }

  /**
   * `$engagement` for the page being left, with that page's context: before the next page's
   * `$pageview` on an SPA navigation, and before the beacon on page hide. If the person comes
   * back to a hidden tab, the next one carries only the time since, so `engaged_ms` adds up.
   */
  function reportEngagement(final: boolean) {
    if (!engagement || !page.url) return;
    const numbers = engagement.take(final);
    if (numbers.engaged_ms < MIN_ENGAGED_MS) return;
    enqueue("track", "$engagement", { properties: { ...numbers } }, page);
  }

  /** Autocapture's entry: one pageview per distinct page, however many signals fired. */
  function autoPage() {
    if (pageKey(host.location.href) === lastPageKey) return;
    capturePage();
  }

  /**
   * Applies a new consent state. This is where the tier changes (docs/consent.md, Upgrading and
   * downgrading within a session).
   */
  function applyConsent(next: ConsentStatus) {
    // Global Privacy Control is a legally binding opt-out of "selling or sharing" in several US
    // states (CCPA/CPRA and others). Marketing consent exists to share data with ad platforms, so
    // a GPC signal denies it. Analytics stays the CMP's decision: measuring one's own site is not
    // sharing. We deliberately do not read Do Not Track: it has no legal weight and the customer's
    // CMP is the place for that decision.
    if (
      (host.navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl ===
      true
    ) {
      next = { ...next, marketing: "denied" };
    }
    const before = status;
    status = next;
    if (!sameStatus(before, next)) {
      const wasConsented = before.analytics === "granted";
      if (!wasConsented && analytics()) upgrade();
      else if (wasConsented && !analytics()) downgrade();
    }
    // After the tier switch, so a waiting first pageview carries the new anonymous id.
    onFirstConsent?.();
  }

  function upgrade() {
    // Client hints are a device read, so they wait for consent. The answer is async: events from
    // now until it arrives go without them.
    if (!hintsAsked) {
      hintsAsked = true;
      void readClientHints(host).then((values) => {
        if (analytics()) hints = values;
      });
    }
    store.open = true;
    anonymousId = store.get(KEYS.anonymousId) ?? uuidv7();
    store.set(KEYS.anonymousId, anonymousId);
    userId ??= store.get(KEYS.userId) ?? undefined;
    groupId ??= store.get(KEYS.groupId) ?? undefined;
    store.set(KEYS.userId, userId);
    store.set(KEYS.groupId, groupId);

    // Events a previous page could not deliver (stored only because consent was given then).
    try {
      const saved: unknown = JSON.parse(store.get(KEYS.queue) ?? "[]");
      if (Array.isArray(saved)) transport?.restore(saved as QueuedEvent[]);
    } catch {
      store.set(KEYS.queue, undefined);
    }

    // The server links the cookieless session of this visit to the new anonymous id, so the
    // visit that led to consent keeps its source.
    if (sentWithoutConsent) {
      enqueue("track", "$consent_changed", {
        properties: { analytics: status.analytics, marketing: status.marketing },
      });
    }
    if (userId && pendingIdentify) {
      enqueue("identify", "$identify", pendingIdentify);
      pendingIdentify = undefined;
    }
  }

  function downgrade() {
    // Revoked: everything MIRA stored on the device goes, and the SDK is cookieless again.
    store.clear();
    store.open = false;
    clearTimeout(persistTimer);
    persistTimer = undefined;
    anonymousId = undefined;
    hints = undefined;
    hintsAsked = false;
  }

  function followConsent(choice: "auto" | ConsentChoice) {
    stopAuto?.();
    stopAuto = undefined;
    if (choice === "auto") {
      stopAuto = autoConsent(host, (next) => applyConsent(next), adapters);
    } else {
      applyConsent(fromChoice(choice));
    }
  }

  function start(settings: MiraOptions) {
    if (started) return warn("init called twice; the first options stay");
    if (!settings?.key) return warn("init needs the project's public key: createMira({ key })");
    if (keyKind(settings.key) === "secret") {
      // Always loud, not only in debug: a secret key in a page is a leak to fix now.
      console.error(
        "MIRA FIVE: this is a secret key (mira_sk_…). It must never be in a web page: rotate it in the dashboard and use the project's public key (mira_pk_…). Nothing is sent.",
      );
      return;
    }
    debug = settings.debug === true;
    adapters = settings.adapters ?? defaultAdapters;
    const origin = trimHost(settings.host ?? DEFAULT_HOST);

    transport = new Transport({
      host: origin,
      key: settings.key,
      fetch: host.fetch.bind(host),
      beacon: host.navigator.sendBeacon
        ? (url, body) => host.navigator.sendBeacon(url, body)
        : undefined,
      persist,
      onError: (message) => warn(message),
    });
    started = true;

    const autocapture = settings.autocapture ?? true;
    const on = (flag: keyof AutocaptureOptions) =>
      autocapture === true || (autocapture !== false && autocapture[flag] !== false);

    // Page hide is the last moment we can send. `pagehide` covers bfcache and Safari, where
    // `visibilitychange` is not always fired on unload.
    const leave = () => {
      reportEngagement(true);
      transport?.beacon();
      persistNow();
    };
    host.document.addEventListener("visibilitychange", () => {
      if (host.document.visibilityState === "hidden") leave();
    });
    host.addEventListener("pagehide", leave);

    const begin = () => {
      // Before the replayed calls, so a queued `page()` already counts its engaged time.
      if (on("engagement")) engagement = watchEngagement(host);
      watchInteractions(
        host,
        { outbound: on("outbound"), downloads: on("downloads"), forms: on("forms") },
        (name, properties) => enqueue("track", name, { properties: cleanProperties(properties) }),
      );
      for (const call of early.splice(0)) call();
      if (on("spa")) watchNavigation(host, autoPage);
      if (!on("pageviews")) return;
      // In auto mode, the first pageview waits briefly for the CMP's answer.
      if (stopAuto && status.analytics === "unknown") {
        const timer = setTimeout(() => onFirstConsent?.(), CONSENT_WAIT_MS);
        onFirstConsent = () => {
          onFirstConsent = undefined;
          clearTimeout(timer);
          autoPage();
        };
      } else {
        autoPage();
      }
    };

    followConsent(settings.consent ?? "auto");

    // A prerendered page may never be seen. Nothing is captured or sent until it is activated.
    if ((host.document as Document & { prerendering?: boolean }).prerendering) {
      transport.paused = true;
      host.document.addEventListener(
        "prerenderingchange",
        () => {
          transport?.resume();
          begin();
        },
        { once: true },
      );
    } else {
      begin();
    }
  }

  const api: Mira = {
    init: guard("init", start),
    page: guard("page", (properties?: Record<string, unknown>) => capturePage(properties)),
    track: guard("track", (name: unknown, properties?: Record<string, unknown>) => {
      if (typeof name !== "string" || !name || name.startsWith("$")) {
        return warn(`invalid event name "${String(name)}" (names starting with $ are reserved)`);
      }
      enqueue("track", name.slice(0, LIMITS.nameLength), {
        properties: cleanProperties(properties),
      });
    }),
    survey: guard("survey", (input: SurveyInput) => {
      const channel =
        input?.channel && (touchpointChannels as readonly string[]).includes(input.channel)
          ? input.channel
          : undefined;
      const source = typeof input?.source === "string" ? input.source.trim() : "";
      if (!channel && !source) return warn("survey needs a source or a channel");
      const fields: Record<string, string> = { kind: "survey" };
      if (channel) fields.channel = channel;
      if (source) fields.source = source.slice(0, 200);
      for (const name of ["medium", "campaign"] as const) {
        const value = input[name];
        if (typeof value === "string" && value.trim()) fields[name] = value.trim().slice(0, 200);
      }
      if (typeof input.answer === "string" && input.answer.trim()) {
        fields.answer = input.answer.trim().slice(0, 500);
      }
      enqueue("track", "$touchpoint", {
        properties: { ...cleanProperties(input.properties), ...fields },
      });
    }),
    // Ids are typed `unknown` here because script-tag callers may pass numbers.
    identify: guard(
      "identify",
      (id: unknown, traits?: Record<string, unknown>, settings?: IdentifyOptions) => {
        const value = idOf(id);
        if (!value) return warn("identify needs a user id");
        userId = value;
        store.set(KEYS.userId, userId);
        const identify: Partial<WireEvent> = { traits: cleanProperties(traits) };
        const externalIds = cleanExternalIds(settings?.externalIds);
        if (externalIds) identify.external_ids = externalIds;
        if (analytics()) enqueue("identify", "$identify", identify);
        else pendingIdentify = identify;
      },
    ),
    group: guard("group", (id: unknown, traits?: Record<string, unknown>) => {
      const value = idOf(id);
      if (!value) return warn("group needs a group id");
      groupId = value;
      store.set(KEYS.groupId, groupId);
      // Without consent the ingest drops the group id, so the event would say nothing.
      if (analytics()) enqueue("group", "$group", { traits: cleanProperties(traits) });
    }),
    consent: guard("consent", (choice: "auto" | ConsentChoice) => {
      if (choice !== "auto" && (!choice || typeof choice !== "object")) {
        return warn("consent expects 'auto' or { analytics, marketing }");
      }
      if (!started) {
        // Before init, the choice is applied by init (it may come from the snippet's stub queue).
        early.unshift(() => followConsent(choice));
        return;
      }
      followConsent(choice);
    }),
    setLocation: guard("setLocation", (next: LocationInput | null) => {
      if (next === null) {
        location = undefined;
        return;
      }
      const { latitude, longitude } = next ?? {};
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
      ) {
        return warn("setLocation expects { latitude: -90..90, longitude: -180..180 } or null");
      }
      // Rounded here, so a precise position never leaves the device.
      location = { latitude: twoDecimals(latitude), longitude: twoDecimals(longitude) };
    }),
    reset: guard("reset", () => {
      // Logout on a shared device: the next person must not be linked to the previous one.
      userId = undefined;
      groupId = undefined;
      pendingIdentify = undefined;
      location = undefined;
      store.set(KEYS.userId, undefined);
      store.set(KEYS.groupId, undefined);
      if (analytics()) {
        anonymousId = uuidv7();
        store.set(KEYS.anonymousId, anonymousId);
      }
    }),
    flush: () => {
      try {
        return transport?.flush().catch(() => {}) ?? Promise.resolve();
      } catch {
        return Promise.resolve();
      }
    },
    get status() {
      return { ...status };
    },
    get anonymousId() {
      return analytics() ? anonymousId : undefined;
    },
  };

  if (options) api.init(options);
  return api;
}
