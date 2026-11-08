import type { ConsentAdapter, ConsentStatus } from "./types";

/**
 * Any IAB TCF v2.2 CMP, through the standard `__tcfapi` (`addEventListener`, `eventStatus`,
 * `purpose.consents`). Written from the IAB "CMP JS API v2" spec; not yet checked against a
 * recorded CMP script.
 *
 * MIRA is not an IAB vendor, so it reads the purposes the person agreed to:
 * - **analytics** needs purpose 1 (store and/or access information on a device) and at least one
 *   measurement purpose: 8 (measure content performance) or 9 (understand audiences through
 *   statistics). Purpose 1 is required because analytics consent is what lets the SDK write its
 *   `anonymous_id` to the device.
 * - **marketing** needs purposes 1, 2 (basic ads), 3 (create an ads profile), 4 (use profiles to
 *   select ads) and 7 (measure ad performance), because marketing consent allows forwarding to ad
 *   platforms. Partial ad consent stays `denied`: compliance first.
 *
 * When the CMP says GDPR does not apply (`gdprApplies === false`), the CMP has decided that no
 * consent is needed for this visitor, and both purposes count as granted.
 */
export interface TcData {
  gdprApplies?: boolean;
  eventStatus?: "tcloaded" | "cmpuishown" | "useractioncomplete";
  listenerId?: number;
  purpose?: { consents?: Record<string, boolean | undefined> };
}

type TcfApi = (
  command: string,
  version: number,
  callback: (data: TcData, success: boolean) => void,
  parameter?: unknown,
) => void;

export const ANALYTICS_PURPOSES = [8, 9];
export const MARKETING_PURPOSES = [1, 2, 3, 4, 7];

/** Maps TCF purpose consents to MIRA's purposes. Shared with the consentmanager adapter. */
export function fromPurposes(consents: Record<string, boolean | undefined>): ConsentStatus {
  const has = (purpose: number) => consents[purpose] === true;
  const analytics = has(1) && ANALYTICS_PURPOSES.some(has);
  const marketing = MARKETING_PURPOSES.every(has);
  return {
    analytics: analytics ? "granted" : "denied",
    marketing: marketing ? "granted" : "denied",
  };
}

export function fromTcData(data: TcData): ConsentStatus | undefined {
  if (data.gdprApplies === false) return { analytics: "granted", marketing: "granted" };
  // The banner is open and the person has not answered yet.
  if (data.eventStatus === "cmpuishown") return { analytics: "unknown", marketing: "unknown" };
  if (data.eventStatus !== "tcloaded" && data.eventStatus !== "useractioncomplete")
    return undefined;
  return fromPurposes(data.purpose?.consents ?? {});
}

export const tcf: ConsentAdapter = {
  name: "tcf",
  detect: (host) => typeof host.__tcfapi === "function",
  subscribe(host, emit) {
    const api = host.__tcfapi as TcfApi;
    let listenerId: number | undefined;
    api("addEventListener", 2, (data, success) => {
      if (!success || !data) return;
      listenerId = data.listenerId ?? listenerId;
      const status = fromTcData(data);
      if (status) emit(status);
    });
    return () => {
      if (listenerId !== undefined) api("removeEventListener", 2, () => {}, listenerId);
    };
  },
};
