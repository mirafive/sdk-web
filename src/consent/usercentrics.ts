import type { ConsentState } from "@mirafive/protocol";

import { listen, MIRA_SERVICE, type ConsentAdapter, type ConsentStatus, type Host } from "./types";

/**
 * Usercentrics, Web CMP v3 (`__ucCmp`) and Browser UI v2 (`UC_UI`).
 *
 * Mapping, in order:
 * 1. If the customer added MIRA FIVE as its own service, that service decides both purposes.
 * 2. Otherwise by category: a `statistics`, `analytics` or `performance` category maps to
 *    analytics. Usercentrics' default setup has no statistics category and files analytics tools
 *    under `marketing`, so without one, analytics follows `marketing`. `marketing` → marketing.
 *
 * Sources:
 * - v3: `window.__ucCmp.getConsentDetails()` (a Promise of `{ consent, services, categories }`)
 *   and the window event `UC_CONSENT` with the same shape in `detail`; `consent.type` is
 *   `IMPLICIT` until the person decides. Documented by Usercentrics' support articles; the exact
 *   `categories[slug].state` values (`ALL_ACCEPTED`, `ALL_DENIED`, a mixed state) are UNVERIFIED
 *   against an official type definition, so a mixed category counts as denied.
 * - v2: `UC_UI.getServicesBaseInfo()` (services with `categorySlug` and `consent.status`) after
 *   `UC_UI_INITIALIZED`, and `UC_UI_CMP_EVENT` on every decision (verified in the v2 UI API docs).
 *   The data layer window event (`ucEvent` by default, name configurable) is also read.
 *   `UC_UI.isConsentRequired()` as the "banner still open" signal is UNVERIFIED.
 */
interface V3Details {
  consent?: { type?: string };
  services?: Record<string, { name?: string; consent?: { given?: boolean } }>;
  categories?: Record<string, { state?: string }>;
}

interface V2Service {
  name?: string;
  categorySlug?: string;
  consent?: { status?: boolean };
}

interface UcUi {
  isInitialized?: () => boolean;
  isConsentRequired?: () => boolean;
  getServicesBaseInfo?: () => V2Service[];
}

const ANALYTICS_CATEGORIES = ["statistics", "analytics", "performance"];
const granted = (value: boolean | undefined): ConsentState => (value ? "granted" : "denied");

/** Shared mapping: a service list (name, consent) and a category lookup (slug → consented). */
function map(
  services: { name?: string; given?: boolean }[],
  category: (slug: string) => boolean | undefined,
): ConsentStatus {
  const mira = services.find((service) => service.name && MIRA_SERVICE.test(service.name));
  if (mira) return { analytics: granted(mira.given), marketing: granted(mira.given) };
  const marketing = category("marketing");
  const analyticsSlug = ANALYTICS_CATEGORIES.find((slug) => category(slug) !== undefined);
  const analytics = analyticsSlug ? category(analyticsSlug) : marketing;
  return { analytics: granted(analytics), marketing: granted(marketing) };
}

export function fromV3(details: V3Details): ConsentStatus {
  if (details.consent?.type && details.consent.type !== "EXPLICIT") {
    return { analytics: "unknown", marketing: "unknown" };
  }
  const services = Object.values(details.services ?? {}).map((service) => ({
    name: service.name,
    given: service.consent?.given,
  }));
  const categories = details.categories ?? {};
  return map(services, (slug) =>
    categories[slug] ? categories[slug].state === "ALL_ACCEPTED" : undefined,
  );
}

export function fromV2(list: V2Service[]): ConsentStatus {
  const services = list.map((service) => ({ name: service.name, given: service.consent?.status }));
  // A category counts as consented when every service in it is.
  return map(services, (slug) => {
    const members = list.filter((service) => service.categorySlug === slug);
    return members.length
      ? members.every((service) => service.consent?.status === true)
      : undefined;
  });
}

export const usercentrics: ConsentAdapter = {
  name: "usercentrics",
  detect: (host) =>
    Boolean(host.__ucCmp || host.UC_UI) ||
    Boolean(host.document.querySelector("script#usercentrics-cmp, script[src*='usercentrics.eu']")),
  subscribe(host: Host, emit) {
    const readV3 = () => {
      const cmp = host.__ucCmp as { getConsentDetails?: () => Promise<V3Details> } | undefined;
      // The v3 API methods are no-ops until the CMP is ready, so a missing answer is ignored.
      cmp
        ?.getConsentDetails?.()
        ?.then((details) => details && emit(fromV3(details)))
        .catch(() => {});
      return Boolean(cmp);
    };
    const readV2 = () => {
      const ui = host.UC_UI as UcUi | undefined;
      if (!ui?.getServicesBaseInfo || ui.isInitialized?.() === false) return;
      if (ui.isConsentRequired?.()) return emit({ analytics: "unknown", marketing: "unknown" });
      emit(fromV2(ui.getServicesBaseInfo()));
    };
    const read = () => {
      if (!readV3()) readV2();
    };

    read();
    return listen(
      host,
      ["UC_CONSENT", "UC_UI_INITIALIZED", "UC_UI_CMP_EVENT", "ucEvent"],
      (event) => {
        const detail = (event as CustomEvent<V3Details | undefined>).detail;
        if (event.type === "UC_CONSENT" && detail) emit(fromV3(detail));
        else read();
      },
    );
  },
};
