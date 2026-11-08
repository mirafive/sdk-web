import type { EventContext } from "@mirafive/protocol";

import type { Host } from "./consent/types";
import { VERSION } from "./version";

export const LIBRARY = { name: "@mirafive/web", version: VERSION } as const;

export interface PageInfo {
  url: string;
  referrer: string;
  /** Set when the page view is captured, so an event sent after leaving keeps the old title. */
  title?: string;
}

/** The high-entropy client hints MIRA uses (docs/data-collection.md, 3. Device and software). */
export interface ClientHints {
  model?: string;
  platformVersion?: string;
}

/** What only T1 adds to the context. Its presence is the tier switch. */
export interface DeviceExtras {
  hints?: ClientHints;
  /** A location the site already has (`setLocation`), never one the SDK asked for. */
  location?: { latitude: number; longitude: number };
}

interface UserAgentData {
  getHighEntropyValues?: (hints: string[]) => Promise<ClientHints>;
}

/** The schema's limits, copied as values so zod stays out of the bundle. */
const MAX_LANGUAGES = 10;
const MAX_LOCALE = 35;
const MAX_DENSITY = 10;

/**
 * Reads the client hints once. Call it only with analytics consent: it is a device read. Chromium
 * only; other browsers resolve to `undefined`. Never rejects.
 */
export async function readClientHints(host: Host): Promise<ClientHints | undefined> {
  try {
    const data = (host.navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
    const values = await data?.getHighEntropyValues?.(["model", "platformVersion"]);
    return values ? { model: values.model, platformVersion: values.platformVersion } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The event context for the current tier (docs/data-collection.md, Tiers).
 *
 * - **T0** (no analytics consent, `device` is undefined): only what the HTTP request itself
 *   would carry anyway: the page URL, its referrer, the title, and the language as two letters (as
 *   in `Accept-Language`). Nothing that is read from the device.
 * - **T1+** (analytics consent): adds the screen, viewport and pixel ratio, the full locale and
 *   the preferred languages, the time zone, the client hints, and a location the site passed.
 */
export function buildContext(host: Host, page: PageInfo, device?: DeviceExtras): EventContext {
  const navigator = host.navigator;
  const language = navigator.language || "";
  const context: EventContext = {
    page: {
      url: page.url,
      referrer: page.referrer || undefined,
      title: (page.title ?? host.document.title) || undefined,
    },
    locale: device ? language : language.slice(0, 2) || undefined,
    library: LIBRARY,
  };
  if (!device) return context;

  const density = host.devicePixelRatio;
  context.screen = {
    width: host.screen?.width,
    height: host.screen?.height,
    density: density > 0 && density <= MAX_DENSITY ? density : undefined,
  };
  context.viewport = { width: host.innerWidth, height: host.innerHeight };
  const languages = navigator.languages;
  if (languages?.length) {
    context.languages = languages.slice(0, MAX_LANGUAGES).map((item) => item.slice(0, MAX_LOCALE));
  }
  try {
    context.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Very old engines without Intl time zones: the server falls back to IP geo.
  }
  const { hints, location } = device;
  if (hints?.model) context.device = { model: hints.model };
  if (hints?.platformVersion) context.os = { version: hints.platformVersion };
  if (location) context.location = location;
  return context;
}
