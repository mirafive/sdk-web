import { borlabs } from "./borlabs";
import { ccm19 } from "./ccm19";
import { consentMode } from "./consent-mode";
import { consentmanager } from "./consentmanager";
import { cookiebot } from "./cookiebot";
import { tcf } from "./tcf";
import { followBanners } from "./follow";
import type { ConsentAdapter, ConsentStatus, Host } from "./types";
import { usercentrics } from "./usercentrics";

/**
 * Detection order. Specific CMPs come before the generic TCF adapter, because several of them
 * (Usercentrics, consentmanager) also install `__tcfapi`, and their own API knows about non-IAB
 * services such as MIRA. Consent Mode is the fallback.
 */
export const defaultAdapters: readonly ConsentAdapter[] = [
  usercentrics,
  cookiebot,
  consentmanager,
  ccm19,
  borlabs,
  tcf,
  consentMode,
];

/**
 * Finds the first CMP on the page and follows it (`followBanners`), with every adapter unless
 * `adapters` names fewer. The returned function stops detection and the active subscription.
 */
export const autoConsent = (
  host: Host,
  emit: (status: ConsentStatus, adapter: string) => void,
  adapters: readonly ConsentAdapter[] = defaultAdapters,
  onDetect?: (adapter: ConsentAdapter) => void,
): (() => void) => followBanners(host, emit, adapters, onDetect);
