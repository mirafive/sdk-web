import { fromPurposes } from "./tcf";
import type { ConsentAdapter, ConsentStatus } from "./types";

/**
 * consentmanager.net, through its `__cmp` API (verified against
 * https://help.consentmanager.net/books/cmp/page/cmp-events and the JavaScript API reference):
 * - `__cmp('getCMPData')` returns `{ consentstring, gdprApplies, purposeConsents, vendorConsents }`
 *   synchronously once the CMP is loaded.
 * - `__cmp('addEventListener', ['consent', handler, false], null)` fires on every decision.
 *
 * Mapping: numeric purpose ids are IAB TCF purposes and use the TCF mapping (`tcf.ts`). In a
 * non-TCF ("classic") setup, consentmanager creates the purposes c51 to c55. Which of them is
 * measurement and which is marketing is UNVERIFIED: we assume c53 = measurement → analytics and
 * c52 = marketing → marketing, the wizard's default order. The project settings will allow an
 * override (docs/consent.md, Mapping per project).
 */
interface CmpData {
  consentstring?: string;
  gdprApplies?: boolean;
  purposeConsents?: Record<string, boolean | undefined>;
}

type CmpApi = (
  command: string,
  parameter?: unknown,
  callback?: unknown,
  async?: boolean,
) => unknown;

export function fromCmpData(data: CmpData): ConsentStatus {
  if (data.gdprApplies === false) return { analytics: "granted", marketing: "granted" };
  // No consent string yet: the person has not answered the banner.
  if (!data.consentstring) return { analytics: "unknown", marketing: "unknown" };
  const purposes = data.purposeConsents ?? {};
  if (Object.keys(purposes).some((id) => /^\d+$/.test(id))) return fromPurposes(purposes);
  return {
    analytics: purposes.c53 ? "granted" : "denied",
    marketing: purposes.c52 ? "granted" : "denied",
  };
}

export const consentmanager: ConsentAdapter = {
  name: "consentmanager",
  detect: (host) => typeof host.__cmp === "function",
  subscribe(host, emit) {
    const api = host.__cmp as CmpApi;
    const read = () => {
      const data = api("getCMPData") as CmpData | undefined;
      if (data && typeof data === "object") emit(fromCmpData(data));
    };
    read();
    api("addEventListener", ["consent", read, false], null);
    return () => {
      api("removeEventListener", ["consent", read, false], null);
    };
  },
};
