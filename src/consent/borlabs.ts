import { listen, type ConsentAdapter } from "./types";

/**
 * Borlabs Cookie 3 for WordPress (verified against https://borlabs.io/docs/javascript-api-v3/):
 * `BorlabsCookie.Consents.hasConsentForServiceGroup(groupId)` and `.hasConsent(serviceId)`, and the
 * window event `borlabs-cookie-consent-saved` after every saved decision.
 *
 * Mapping: the `statistics` service group → analytics, the `marketing` group → marketing (the
 * default group ids). A `mira-five` service, if the customer created one, grants analytics too.
 *
 * The API cannot tell "not answered yet" from "declined", so before the first save event in this
 * page a missing consent reads as `unknown`; both are T0, only the stamp differs. Borlabs Cookie 2
 * (`BorlabsCookie.checkCookieGroupConsent`) is not supported.
 */
interface Borlabs {
  Consents?: {
    hasConsent?: (serviceId: string) => boolean;
    hasConsentForServiceGroup?: (groupId: string) => boolean;
  };
}

export const borlabs: ConsentAdapter = {
  name: "borlabs",
  detect: (host) => Boolean((host.BorlabsCookie as Borlabs | undefined)?.Consents),
  subscribe(host, emit) {
    let saved = false;
    const read = (event?: Event) => {
      if (event) saved = true;
      const consents = (host.BorlabsCookie as Borlabs | undefined)?.Consents;
      if (!consents?.hasConsentForServiceGroup) return;
      const analytics =
        consents.hasConsentForServiceGroup("statistics") ||
        consents.hasConsent?.("mira-five") === true;
      const marketing = consents.hasConsentForServiceGroup("marketing");
      const missing = saved ? "denied" : "unknown";
      emit({
        analytics: analytics ? "granted" : missing,
        marketing: marketing ? "granted" : missing,
      });
    };
    read();
    return listen(host, ["borlabs-cookie-consent-saved"], read);
  },
};
