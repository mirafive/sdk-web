import type { ShopifyEvent } from "./pixel";

/**
 * Where the events a snippet hands over with `mira("shopifyEvent", event)` wait until the pixel
 * has subscribed. It never grows without an end: a pixel that brought its own `analytics` hears
 * Shopify directly (nothing is kept), and once the pixel failed to start nothing is kept either.
 */
export function eventFeed(hearsShopifyItself: boolean) {
  const listeners: ((event: ShopifyEvent) => void)[] = [];
  const early: ShopifyEvent[] = [];
  let stopped = false;
  return {
    hear(event: ShopifyEvent) {
      if (hearsShopifyItself || stopped) return;
      if (listeners.length) for (const listener of listeners) listener(event);
      else early.push(event);
    },
    /** The pixel's own subscription: it gets what waited, then every later event. */
    subscribe(handler: (event: ShopifyEvent) => void) {
      listeners.push(handler);
      for (const event of early.splice(0)) handler(event);
    },
    /** The pixel did not start: forget what waited and keep nothing more. */
    stop() {
      stopped = true;
      early.length = 0;
      listeners.length = 0;
    },
    get waiting() {
      return early.length;
    },
  };
}
