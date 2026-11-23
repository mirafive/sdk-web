import type { ConsentState } from "@mirafive/protocol";

import { autoConsent } from "./auto";
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

export const shopify: ConsentAdapter = {
  name: "shopify",
  detect: (host) => {
    const global = host.Shopify as ShopifyGlobal | undefined;
    return Boolean(global?.customerPrivacy || global?.loadFeatures);
  },
  subscribe(host, emit) {
    const read = () => {
      const privacy = (host.Shopify as ShopifyGlobal | undefined)?.customerPrivacy;
      if (privacy) emit(fromCustomerPrivacy(privacy));
    };
    emit({ analytics: "unknown", marketing: "unknown" });
    const global = host.Shopify as ShopifyGlobal;
    if (global.customerPrivacy) read();
    else {
      global.loadFeatures?.([{ name: "consent-tracking-api", version: "1.0" }], (error) => {
        if (error) console.warn("MIRA FIVE: Shopify's consent API could not be loaded", error);
        else read();
      });
    }
    // Shopify dispatches on the document and does not bubble.
    host.document.addEventListener("visitorConsentCollected", read);
    return () => host.document.removeEventListener("visitorConsentCollected", read);
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
): () => void {
  let bannerFound = false;
  let stopShopify = () => {};
  const stopBanners = autoConsent(
    host,
    (status) => emit(status),
    banners(adapters),
    () => {
      bannerFound = true;
      stopShopify();
      emit({ analytics: "unknown", marketing: "unknown" });
    },
  );
  if (!bannerFound && shopify.detect(host)) {
    stopShopify = shopify.subscribe(host, (status) => {
      if (!bannerFound) emit(status);
    });
  }
  return () => {
    stopBanners();
    stopShopify();
  };
}
