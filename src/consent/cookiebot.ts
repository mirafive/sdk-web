import { listen, type ConsentAdapter } from "./types";

/**
 * Cookiebot (verified against https://www.cookiebot.com/en/developer/): the global `Cookiebot`
 * object exposes `consent.statistics`, `consent.marketing` and `hasResponse`; the window events
 * `CookiebotOnConsentReady`, `CookiebotOnAccept` and `CookiebotOnDecline` fire when the state is
 * loaded from the cookie or changed by the person.
 *
 * Mapping: statistics → analytics, marketing → marketing. Until `hasResponse` is true the banner
 * is still open, so both purposes stay `unknown`.
 */
interface Cookiebot {
  hasResponse?: boolean;
  consent?: { statistics?: boolean; marketing?: boolean };
}

export const cookiebot: ConsentAdapter = {
  name: "cookiebot",
  detect: (host) =>
    Boolean(host.Cookiebot) ||
    Boolean(host.document.querySelector("script[src*='consent.cookiebot.']")),
  subscribe(host, emit) {
    const read = () => {
      const bot = host.Cookiebot as Cookiebot | undefined;
      if (!bot?.consent) return;
      if (!bot.hasResponse) return emit({ analytics: "unknown", marketing: "unknown" });
      emit({
        analytics: bot.consent.statistics ? "granted" : "denied",
        marketing: bot.consent.marketing ? "granted" : "denied",
      });
    };
    read();
    return listen(
      host,
      ["CookiebotOnConsentReady", "CookiebotOnAccept", "CookiebotOnDecline"],
      read,
    );
  },
};
