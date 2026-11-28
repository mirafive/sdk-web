/**
 * Shopify mode's parts as a script, built to `dist/mira-shopify.js` and served beside `mira.js` as
 * `/sdk/mira-shopify@<version>.js`: Shopify's consent, and the cookie and cart hook. The script tag
 * of the same release loads it for `data-consent="shopify"` (or `mira('consent', 'shopify')`); it
 * registers under that release's name and does nothing else.
 */
import { followShopify } from "../consent/shopify";
import type { ShopifyParts } from "../core";
import { siblingSlot } from "../sibling";
import { VERSION } from "../version";
import { shopifyStorefront } from "./storefront";

(globalThis as Record<symbol, unknown>)[siblingSlot("shopify", VERSION)] = {
  follow: followShopify,
  storefront: shopifyStorefront,
} satisfies ShopifyParts;
