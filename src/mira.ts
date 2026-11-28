/**
 * The SDK with every part at hand: what the npm entry and the tests build on. The script tag
 * (`snippet.ts`) and pixel mode (`shopify/pixel.ts`) build on `createCore` with fewer parts.
 */
import { watchNavigation } from "./autocapture";
import { watchEngagement, watchInteractions } from "./behavior";
import { defaultAdapters } from "./consent/auto";
import { followShopify } from "./consent/shopify";
import type { Host } from "./consent/types";
import { createCore, type EventMap, type Mira, type MiraOptions } from "./core";
import type { ReplayFactory } from "./replay/control";
import { shopifyStorefront } from "./shopify/storefront";
import type { SignalsFactory } from "./signals/control";

export type {
  AutocaptureOptions,
  EventMap,
  IdentifyOptions,
  LocationInput,
  Mira,
  MiraOptions,
  SurveyInput,
} from "./core";

/** Shopify mode's parts, for an entry that has them at hand. */
export const SHOPIFY = { follow: followShopify, storefront: shopifyStorefront };

/** Every automatic event, for an entry that has them at hand. */
export const CAPTURE = {
  engagement: watchEngagement,
  interactions: watchInteractions,
  navigation: watchNavigation,
};

/**
 * Creates an SDK instance. Pass options to start it at once, or call `init` later; calls made
 * before `init` are kept and replayed. `host` is the window, injectable for tests.
 */
export function createMira<Events extends EventMap = EventMap>(
  options?: MiraOptions,
  host: Host = globalThis as unknown as Host,
  /** The time an event gets. */
  now?: () => Date,
  /** How the recorder file loads; none, and the instance never records. */
  replay?: ReplayFactory,
  /** How the signals detector loads; none, and the instance detects none. */
  signals?: SignalsFactory,
): Mira<Events> {
  return createCore<Events>(options, host, {
    now,
    replay,
    signals,
    adapters: defaultAdapters,
    shopify: SHOPIFY,
    capture: CAPTURE,
  });
}
