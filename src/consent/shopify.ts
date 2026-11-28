import type { ConsentState } from "@mirafive/protocol";

import type { followBanners } from "./follow";
import type { ConsentAdapter, ConsentStatus, Host } from "./types";

/**
 * Shopify's Customer Privacy API on a storefront (verified against
 * https://shopify.dev/docs/api/customer-privacy): `Shopify.customerPrivacy` has
 * `analyticsProcessingAllowed()` and `marketingAllowed()` (true once consent is given, or where none
 * is required), and `shouldShowBanner()`. The event `visitorConsentCollected` is dispatched on
 * `document` (not `window`, and it does not bubble) after every decision. The API is a feature that
 * a theme loads (`Shopify.loadFeatures`); this adapter loads it itself when the page has not.
 *
 * Opt-in (`consent: 'shopify'`), never detected: `window.Shopify` is on every storefront, and where
 * the merchant has not set Shopify's privacy regions `analyticsProcessingAllowed()` is true for
 * everyone. A store that chooses it must have Shopify's privacy settings and banner set up for its
 * regions. Even then a third-party banner (Cookiebot, Usercentrics, …) that appears wins: it is the
 * stricter, explicit source (`followShopify`).
 *
 * Mapping: analytics → analytics, marketing → marketing. A purpose that is not allowed while the
 * banner still waits for an answer is `unknown`, so the first pageview waits briefly for it;
 * without a banner it is `denied`.
 */
export interface CustomerPrivacy {
  analyticsProcessingAllowed?: () => boolean;
  marketingAllowed?: () => boolean;
  shouldShowBanner?: () => boolean;
  /** `{ analytics, marketing }` as `'yes'`, `'no'` or `''` (not answered). */
  currentVisitorConsent?: () => { analytics?: string; marketing?: string } | undefined;
}

/**
 * What the Customer Privacy API says, as MIRA's consent. An explicit "no" is a denial. Otherwise
 * `analyticsProcessingAllowed()` decides, and a purpose that is not allowed while the banner still
 * waits for an answer (`shouldShowBanner()`) is `unknown`. Shopify's documentation is unclear on
 * whether `shouldShowBanner()` turns false after a decision, hence the explicit answer first.
 */
export function fromCustomerPrivacy(privacy: CustomerPrivacy): ConsentStatus {
  const waiting = privacy.shouldShowBanner?.() === true;
  const answers = privacy.currentVisitorConsent?.();
  const purpose = (answer: string | undefined, allowed: boolean | undefined): ConsentState =>
    answer === "no" ? "denied" : allowed ? "granted" : waiting ? "unknown" : "denied";
  return {
    analytics: purpose(answers?.analytics, privacy.analyticsProcessingAllowed?.()),
    marketing: purpose(answers?.marketing, privacy.marketingAllowed?.()),
  };
}

interface ShopifyGlobal {
  customerPrivacy?: CustomerPrivacy;
  loadFeatures?: (
    features: { name: string; version: string }[],
    callback: (error?: unknown) => void,
  ) => void;
}

/** How often, and for how long, a storefront without the API yet is looked at again. */
const POLL_MS = 100;
const WAIT_MS = 5_000;

export const shopify: ConsentAdapter = {
  name: "shopify",
  detect: (host) => {
    const global = host.Shopify as ShopifyGlobal | undefined;
    return Boolean(global?.customerPrivacy || global?.loadFeatures);
  },
  /**
   * Follows the API without deciding once whether it is there: an async script that runs before
   * Shopify's own head scripts has no `Shopify.customerPrivacy` or `Shopify.loadFeatures` yet.
   * Until the answer is known the consent stays `unknown` (nothing is stored). The `document`
   * listener is added at once; the API itself is looked for again at `DOMContentLoaded` and every
   * 100 ms for five seconds, asked for with `loadFeatures` when only that exists (an error is
   * logged and the look goes on: the theme may still load it).
   */
  subscribe(host, emit) {
    const global = () => host.Shopify as ShopifyGlobal | undefined;
    /** Stopped by the caller: nothing is read or emitted after it, whatever Shopify answers. */
    let stopped = false;
    /** The look is over (found, or five seconds): a late `loadFeatures` answer is still heard. */
    let looking = true;
    let asked = false;
    let warned = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const warnOnce = (message: string, error: unknown) => {
      if (warned) return;
      warned = true;
      console.warn(`MIRA FIVE: ${message}`, error);
    };
    const stopLooking = () => {
      looking = false;
      clearInterval(timer);
      host.document.removeEventListener("DOMContentLoaded", look);
    };
    /** Emits what the API says, once it is there. A broken API counts as not there yet. */
    const read = () => {
      if (stopped) return false;
      let status: ConsentStatus | undefined;
      try {
        const privacy = global()?.customerPrivacy;
        if (privacy) status = fromCustomerPrivacy(privacy);
      } catch (error) {
        warnOnce("Shopify's consent API threw", error);
      }
      if (status) emit(status);
      return Boolean(status);
    };
    const started = Date.now();
    function look() {
      if (!looking || stopped) return;
      if (read()) return stopLooking();
      try {
        const api = global();
        if (api?.loadFeatures && !asked) {
          asked = true;
          api.loadFeatures([{ name: "consent-tracking-api", version: "1.0" }], (error) => {
            if (error) warnOnce("Shopify's consent API could not be loaded", error);
            // Also after the five seconds: on a slow connection the answer may come late.
            else if (read()) stopLooking();
          });
        }
      } catch (error) {
        warnOnce("Shopify's consent API could not be asked", error);
      }
      if (Date.now() - started > WAIT_MS) stopLooking();
    }
    // A decision (heard on the document, which it does not bubble from) also ends the look.
    const onDecision = () => {
      if (read()) stopLooking();
    };
    emit({ analytics: "unknown", marketing: "unknown" });
    host.document.addEventListener("visitorConsentCollected", onDecision);
    host.document.addEventListener("DOMContentLoaded", look);
    timer = setInterval(look, POLL_MS);
    look();
    return () => {
      stopped = true;
      stopLooking();
      host.document.removeEventListener("visitorConsentCollected", onDecision);
    };
  },
};

/** Banners the Shopify mode switches to: every detected CMP, not the generic fallbacks. */
const banners = (adapters: readonly ConsentAdapter[]) =>
  adapters.filter((adapter) => !adapter.fallback);

/**
 * `consent: 'shopify'`: Shopify's answer, unless another known banner is on the page. The banners
 * are looked for first: one that is detected (its script may not have loaded yet) owns the
 * decision from the start, so Shopify's "allowed" never touches the device before the visitor has
 * answered it. A banner that only appears later (a tag manager) takes over for good; by then
 * Shopify's answer may already have been used, so the device was written to before that.
 */
export function followShopify(
  host: Host,
  emit: (status: ConsentStatus) => void,
  adapters: readonly ConsentAdapter[],
  /** The core's banner follower, passed in so Shopify's file of the script tag does not carry its own. */
  follow: typeof followBanners,
): () => void {
  let bannerFound = false;
  let answered = false;
  let stopShopify = () => {};
  const stopBanners = follow(
    host,
    (status) => emit(status),
    banners(adapters),
    () => {
      bannerFound = true;
      stopShopify();
      // Before Shopify has answered nothing may be written: hold at "unknown" until the banner
      // speaks. After it has, the banner's own answer follows at once (a stored "yes" keeps the
      // visitor's id, a "no" removes it, a banner still waiting says "unknown" itself); a
      // made-up "unknown" in between would clear the storage and mint a new id on every page.
      if (!answered) emit({ analytics: "unknown", marketing: "unknown" });
    },
  );
  if (!bannerFound) {
    stopShopify = shopify.subscribe(host, (status) => {
      if (bannerFound) return;
      if (status.analytics !== "unknown") answered = true;
      emit(status);
    });
  }
  return () => {
    stopBanners();
    stopShopify();
  };
}
