import type { EventMap, Mira } from "./mira";

const nothing = () => {};

/**
 * A client that does nothing: what framework bindings hand out while rendering on a server, or
 * when no key is configured. Every call is accepted and ignored, so code never needs a guard.
 */
export function createNoopMira<Events extends EventMap = EventMap>(): Mira<Events> {
  return {
    init: nothing,
    page: nothing,
    track: nothing,
    survey: nothing,
    identify: nothing,
    group: nothing,
    consent: nothing,
    setLocation: nothing,
    reset: nothing,
    flush: () => Promise.resolve(),
    status: { analytics: "unknown", marketing: "unknown" },
    anonymousId: undefined,
  };
}
