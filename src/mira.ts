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
import { followShopify } from "./consent/shopify";
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
import { shopifyStorefront } from "./shopify/storefront";
import type { ReplayControl, ReplayFactory } from "./replay/control";
import type { Signals, SignalsFactory } from "./signals/control";
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
  /**
   * `'auto'` follows the CMP on the page (default); an object sets the state for custom banners.
   * `'shopify'` is for a Shopify storefront: it follows Shopify's Customer Privacy API (so the shop's
   * privacy settings and banner must be set up for its regions), switches to any other known
   * banner that appears, and shares the visitor's id with checkout (a cookie and the cart
   * attribute `_mira_aid`) when `window.Shopify` is there.
   */
  consent?: "auto" | "shopify" | ConsentChoice;
  /** What the SDK captures on its own; all on by default. `false` turns everything off. */
  autocapture?: boolean | AutocaptureOptions;
  /** The CMP adapters `'auto'` tries, in order. Pass a subset to keep the bundle small. */
  adapters?: readonly ConsentAdapter[];
  /** Logs dropped events and failed batches to the console. */
  debug?: boolean;
  /**
   * For platform integrations (Shopify's cart attribute): called with the visitor's anonymous id
   * when analytics consent makes one or `reset` makes a new one, and with `undefined` whenever
   * consent is known not to be given, so an integration can remove what an earlier visit left.
   */
  onAnonymousId?: (anonymousId: string | undefined) => void;
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
  /**
   * Behavior signals (rage and dead clicks, abandoned forms, errors, slow pages) when the project
   * has them on: a file of their own, loaded only then.
   */
  signals?: boolean;
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
  /** `$non_interaction: true` marks an event the person did not cause: it starts no visit. */
  track<Name extends keyof Events & string>(
    name: Name,
    properties: Events[Name] & { $non_interaction?: boolean },
  ): void;
  /** A survey answer ("How did you hear about us?") as a touchpoint. */
  survey(input: SurveyInput): void;
  identify(userId: string, traits?: Record<string, unknown>, options?: IdentifyOptions): void;
  group(groupId: string, traits?: Record<string, unknown>): void;
  consent(choice: "auto" | "shopify" | ConsentChoice): void;
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
  /** The time an event gets. Pixel mode passes the time Shopify gave the event. */
  now: () => Date = () => new Date(),
  /**
   * Session recording: the script tag and the npm entry pass how they load the recorder file;
   * pixel mode passes none, so it never records.
   */
  replayFactory?: ReplayFactory,
  /** Behavior signals: how the detector file loads; pixel mode passes none. */
  signalsFactory?: SignalsFactory,
): Mira<Events> {
  let started = false;
  let debug = false;
  const early: (() => void)[] = [];
  let transport: Transport | undefined;
  let replay: ReplayControl | undefined;
  let signals: Signals | undefined;

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
  /** The `event_id` of the current page's `$pageview`: its `$engagement` events name it. */
  let pageEventId: string | undefined;
  let onAnonymousId: MiraOptions["onAnonymousId"];
  /** A `consent` call made before `init`: it wins over the option, as it did when replayed after. */
  let pendingConsent: "auto" | "shopify" | ConsentChoice | undefined;
  /** `consent: 'shopify'` is the page's choice: the hook is wired when Shopify is there, even if late. */
  let shopifyMode = false;

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
  ): string | undefined {
    if (!transport) return undefined;
    const consented = analytics();
    const queued: QueuedEvent = {
      event_id: uuidv7(),
      type,
      event,
      timestamp: now().toISOString(),
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
    if (extra.page_event_id) queued.page_event_id = extra.page_event_id;
    transport.enqueue(queued);
    return queued.event_id;
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
    pageEventId = enqueue("page", "$pageview", { properties: cleanProperties(properties) });
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
    // The server puts the engagement into its pageview's visit, even when the tab is shown again
    // an hour later. No identifier: the id of an event this page already sent.
    enqueue(
      "track",
      "$engagement",
      { properties: { ...numbers }, ...(pageEventId ? { page_event_id: pageEventId } : {}) },
      page,
    );
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
    // Shopify may appear after init (an async script that ran before Shopify's head scripts): the
    // cookie and cart hook is wired before the first tier change that needs it.
    if (shopifyMode) wireShopify(next);
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
    // Told once after a "no", so an integration removes what an earlier visit left (Shopify's cart).
    let forget = next.analytics === "denied";
    if (!sameStatus(before, next)) {
      const wasConsented = before.analytics === "granted";
      // An engagement sent under the new tier must not point at a pageview of the old one: that
      // would tie an event without ids to one with them (or the other way round).
      if (wasConsented !== analytics()) pageEventId = undefined;
      if (!wasConsented && analytics()) upgrade();
      else if (wasConsented && !analytics()) {
        downgrade();
        forget = true;
      }
      // Recording follows analytics consent: loaded at T1, stopped and withdrawn below it.
      if (wasConsented !== analytics()) replay?.consent(analytics());
    }
    if (forget) announceId();
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
    announceId();

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

  /** The cookie and cart hook of Shopify mode, unless the page brought its own. */
  function wireShopify(next?: ConsentStatus) {
    if (onAnonymousId || !host.Shopify) return;
    onAnonymousId = shopifyStorefront(host, warn);
    // Consent may be given already (a banner's stored "yes"): tell the hook about the id it has not
    // heard of. Not when the change in hand is a "no": the clean-up that follows is all it needs.
    if (analytics() && (next ? next.analytics === "granted" : true)) announceId();
  }

  /** Looks again when the page has loaded, for a page whose Shopify scripts run after this one. */
  let stopWiring: (() => void) | undefined;
  function wireWhenShopifyComes() {
    stopWiring?.();
    stopWiring = undefined;
    if (!shopifyMode) return;
    wireShopify();
    if (onAnonymousId) return;
    const retry = () => {
      wireShopify();
      if (onAnonymousId) stopWiring?.();
    };
    stopWiring = () => {
      host.document.removeEventListener("DOMContentLoaded", retry);
      host.removeEventListener("load", retry);
      stopWiring = undefined;
    };
    host.document.addEventListener("DOMContentLoaded", retry);
    host.addEventListener("load", retry);
  }

  function announceId() {
    try {
      onAnonymousId?.(anonymousId);
    } catch (error) {
      warn("onAnonymousId failed", error);
    }
  }

  function followConsent(choice: "auto" | "shopify" | ConsentChoice) {
    stopAuto?.();
    stopAuto = undefined;
    if (choice === "auto") {
      stopAuto = autoConsent(host, (next) => applyConsent(next), adapters);
    } else if (choice === "shopify") {
      stopAuto = followShopify(host, (next) => applyConsent(next), adapters);
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
    const choice = pendingConsent ?? settings.consent ?? "auto";
    pendingConsent = undefined;
    onAnonymousId = settings.onAnonymousId;
    // `consent: 'shopify'` on a storefront also shares the visitor's id with checkout.
    shopifyMode = choice === "shopify";
    wireWhenShopifyComes();
    adapters = settings.adapters ?? defaultAdapters;
    const origin = trimHost(settings.host ?? DEFAULT_HOST);
    const send = host.fetch.bind(host);
    const beacon = host.navigator.sendBeacon
      ? (url: string, body: string | Blob) => host.navigator.sendBeacon(url, body)
      : undefined;

    replay = replayFactory?.({
      host,
      ingest: origin,
      key: settings.key,
      fetch: send,
      beacon,
      query: () => ({
        consent_analytics: status.analytics,
        consent_marketing: status.marketing,
        ...(analytics() && anonymousId ? { anonymous_id: anonymousId } : {}),
        ...(analytics() && userId ? { user_id: userId } : {}),
      }),
      warn,
    });
    const autocapture = settings.autocapture ?? true;
    const on = (flag: keyof AutocaptureOptions) =>
      autocapture === true || (autocapture !== false && autocapture[flag] !== false);
    signals = on("signals")
      ? signalsFactory?.({
          host,
          analytics,
          track: (name, properties, url) =>
            enqueue("track", name, { properties }, url ? { ...pageNow(), url } : undefined),
        })
      : undefined;
    transport = new Transport({
      host: origin,
      key: settings.key,
      fetch: send,
      beacon,
      persist,
      onAnswer: (body) => {
        replay?.answer(body);
        signals?.answer(body);
      },
      onError: (message) => warn(message),
    });
    started = true;

    // Page hide is the last moment we can send. `pagehide` covers bfcache and Safari, where
    // `visibilitychange` is not always fired on unload.
    const leave = (left?: unknown) => {
      // Signals first: what the page leaves behind (a form, a slow page) goes with the beacon.
      signals?.hide(left);
      reportEngagement(true);
      transport?.beacon();
      persistNow();
      replay?.hide();
    };
    host.document.addEventListener("visibilitychange", () => {
      if (host.document.visibilityState === "hidden") leave();
    });
    host.addEventListener("pagehide", leave);
    host.addEventListener("pageshow", (event) =>
      replay?.shown((event as PageTransitionEvent).persisted),
    );

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

    followConsent(choice);

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
    consent: guard("consent", (choice: "auto" | "shopify" | ConsentChoice) => {
      if (choice !== "auto" && choice !== "shopify" && (!choice || typeof choice !== "object")) {
        return warn("consent expects 'auto', 'shopify' or { analytics, marketing }");
      }
      if (!started) {
        // Before init the choice is kept and becomes init's own: applied after `init` started
        // with `auto`, the page would follow a CMP's or Consent Mode's grant first.
        pendingConsent = choice;
        return;
      }
      // The hook first: Shopify's answer is applied at once, and a "no" must reach it, to remove
      // what an earlier visit left.
      shopifyMode = choice === "shopify";
      wireWhenShopifyComes();
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
      // Logout on a shared device: the next person must not be linked to the previous one. What is
      // recorded so far leaves under the previous ids.
      replay?.reset();
      userId = undefined;
      groupId = undefined;
      pendingIdentify = undefined;
      location = undefined;
      // Nor through the page: an engagement after this must not name the previous person's pageview.
      pageEventId = undefined;
      store.set(KEYS.userId, undefined);
      store.set(KEYS.groupId, undefined);
      if (analytics()) {
        anonymousId = uuidv7();
        store.set(KEYS.anonymousId, anonymousId);
        announceId();
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
