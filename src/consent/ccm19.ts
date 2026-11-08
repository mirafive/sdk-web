import { listen, MIRA_SERVICE, type ConsentAdapter } from "./types";

/**
 * CCM19 (verified against https://docs.ccm19.com/api/javascript-apis/): the global `CCM` exposes
 * `consent` (true once the dialog was answered) and `acceptedEmbeddings` (`[{ id, name }]`). The
 * window event `ccm19WidgetClosed` fires after every decision, also for API calls; `ccm19WidgetLoaded`
 * fires once CCM19 has initialised.
 *
 * Mapping: CCM19's JavaScript API exposes accepted embeddings, not categories, so the customer adds
 * MIRA FIVE as an embedding. Its acceptance grants analytics. Marketing follows a second embedding
 * whose name contains "MIRA FIVE" and "Marketing"; without one, marketing stays denied. Guessing
 * from other tools' names would not be a decision the person made for MIRA.
 */
interface Ccm {
  consent?: boolean;
  acceptedEmbeddings?: { id?: string; name?: string }[];
}

export const ccm19: ConsentAdapter = {
  name: "ccm19",
  detect: (host) =>
    Boolean(host.CCM) ||
    Boolean(host.document.querySelector("script[src*='ccm19'], script[src*='/ccm/public/']")),
  subscribe(host, emit) {
    const read = () => {
      const ccm = host.CCM as Ccm | undefined;
      if (!ccm) return;
      if (!ccm.consent) return emit({ analytics: "unknown", marketing: "unknown" });
      const mira = (ccm.acceptedEmbeddings ?? []).filter(
        (item) => item.name && MIRA_SERVICE.test(item.name),
      );
      const marketing = mira.some((item) => /marketing/i.test(item.name!));
      const analytics = mira.some((item) => !/marketing/i.test(item.name!)) || marketing;
      emit({
        analytics: analytics ? "granted" : "denied",
        marketing: marketing ? "granted" : "denied",
      });
    };
    read();
    return listen(host, ["ccm19WidgetClosed", "ccm19WidgetLoaded"], read);
  },
};
