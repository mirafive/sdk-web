import type { Host } from "../consent/types";

/**
 * What the storefront shares with checkout. Shopify runs checkout (and the customer events pixel)
 * in a sandbox where MIRA's script cannot run and `localStorage` is another origin's, so the
 * visitor's id travels two ways, both only with analytics consent:
 *
 * - a first-party cookie, `mira_aid`, which the pixel reads through Shopify's `browser.cookie`;
 * - the cart attribute `_mira_aid`, which Shopify copies to the order as `note_attributes`. The
 *   order webhook carries it to MIRA, which joins a guest's order to their visit. It is not
 *   private: a single underscore keeps it out of Shopify's default cart form, but it shows in the
 *   theme's `cart.attributes` and on the order in the admin. (Only a double underscore hides an
 *   attribute, and it is not known that one reaches the webhook.)
 *
 * The name and the value (the bare anonymous id; empty means none) are a contract with the
 * connectors (docs/connectors.md, Shopify): never change them in a patch release.
 */
export const VISITOR_COOKIE = "mira_aid";
export const CART_ATTRIBUTE = "_mira_aid";

const YEAR_S = 365 * 24 * 60 * 60;

const readCookie = (host: Host, name: string) => {
  for (const part of host.document.cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
};

/** `/cart/update.js` under the shop's locale path (`/de/`), as Shopify says the theme knows it. */
const updateUrl = (host: Host) =>
  `${(host.Shopify as { routes?: { root?: string } } | undefined)?.routes?.root ?? "/"}cart/update.js`;

/** The cart and id the attribute holds, kept for the tab so a page view posts nothing again. */
const SYNCED_KEY = "mira_cart";
/** Set when an id write starts, removed only once a clear succeeded: the cart may hold an id. */
const OPEN_KEY = "mira_cart_open";

/** What the cart attribute should hold: an id, or `""` to empty it, for one cart. */
interface Want {
  value: string;
  key: string;
}

/**
 * Returns an `onAnonymousId` hook. It mirrors the id to the cookie and keeps the cart's attribute
 * current: the cart cookie holds the cart's token, so a new cart (the first add to cart, or one
 * after an order) gets the attribute, a new id (`reset`) replaces the old one, and a page that is
 * left is the last chance to set it before checkout. A visitor without a cart creates none.
 *
 * The cart is written by one queue, one request at a time, and only the latest wish counts: an id
 * that was revoked and granted again within a round trip ends as the new id, never as an empty
 * attribute. A clear is also sent at once when a write is in flight, so a page that is closing
 * still sends it; the queue sends it again after that write.
 *
 * Consent that is not given removes what an earlier visit left, also when the "no" comes on another
 * page than the "yes". The reads below T1 for that are these, once per page, and only to delete:
 * MIRA's own cookie `mira_aid`, the tab's records `mira_cart` and `mira_cart_open`, and, while a
 * clear is pending, Shopify's `cart` cookie (its token says whether a cart exists).
 */
export function shopifyStorefront(
  host: Host,
  warn: (message: string, error?: unknown) => void = () => {},
): (id: string | undefined) => void {
  let id: string | undefined;
  /** The cart and id the attribute holds now: written again when either changes. */
  let synced: string | undefined;
  /** An earlier visit may have left the id on the cart; empty it. */
  let pendingClear = false;
  let hooked = false;
  /** Whether this page already looked for what an earlier visit left. */
  let looked = false;
  let tab: Storage | undefined | null = null;
  const session = () => {
    if (tab === null) {
      try {
        tab = host.sessionStorage;
      } catch {
        tab = undefined;
      }
    }
    return tab;
  };

  let want: Want | undefined;
  let running = false;
  /** A clear went out at once for the current wish, so it is not sent again before the queue's. */
  let earlyClear = false;
  /** That clear, while it is on its way: the queue sends nothing after it until it has landed. */
  let early: Promise<boolean> | undefined;
  /** Whether MIRA's cookie may be on the device: written by this page or found, not yet deleted. */
  let cookie = false;

  const send = (value: string, keepalive: boolean) =>
    host
      .fetch(updateUrl(host), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ attributes: { [CART_ATTRIBUTE]: value } }),
        credentials: "same-origin",
        keepalive,
      })
      .then((response) => {
        if (!response.ok) warn(`the cart attribute was refused (${response.status})`);
        return response.ok;
      })
      .catch((error) => {
        warn("the cart attribute could not be written", error);
        return false;
      });

  const finish = (done: Want) => {
    if (done.value) {
      // Consent may have ended while the write was on its way: nothing is kept in the tab then.
      if (!id) return;
      synced = done.key;
      session()?.setItem(SYNCED_KEY, done.key);
    } else {
      pendingClear = false;
      synced = undefined;
      session()?.removeItem(SYNCED_KEY);
      session()?.removeItem(OPEN_KEY);
    }
  };

  const pump = async (keepalive: boolean) => {
    if (running) return;
    running = true;
    try {
      while (want) {
        const current = want;
        await early;
        if (!(await send(current.value, keepalive))) return; // kept: the next sync tries again
        // Only the latest wish is done; an earlier one that was replaced is just followed.
        if (want === current) {
          want = undefined;
          finish(current);
        }
      }
    } finally {
      running = false;
    }
  };

  const wish = (next: Want, keepalive: boolean) => {
    if (want?.value === next.value && want.key === next.key) {
      // Already asked for: a retry only when nothing is on its way.
      if (!running) void pump(keepalive);
      return;
    }
    want = next;
    if (next.value) {
      earlyClear = false;
      session()?.setItem(OPEN_KEY, "1");
    }
    if (!running) {
      void pump(keepalive);
      return;
    }
    if (!next.value && !earlyClear) {
      earlyClear = true;
      // Kept: an id written next must not be overtaken by this clear on its way.
      early = send("", true);
    }
  };

  const sync = (keepalive: boolean) => {
    const cart = readCookie(host, "cart");
    if (!cart) return;
    if (id) {
      const key = `${cart}:${id}`;
      if (key !== synced || want) wish({ value: id, key }, keepalive);
    } else if (pendingClear) {
      wish({ value: "", key: `${cart}:` }, keepalive);
    }
  };

  return (next) => {
    const hadId = id !== undefined;
    id = next;
    try {
      if (next) {
        pendingClear = false;
        synced ??= session()?.getItem(SYNCED_KEY) ?? undefined;
        cookie = true;
        host.document.cookie = `${VISITOR_COOKIE}=${next}; Max-Age=${YEAR_S}; Path=/; SameSite=Lax${host.location.protocol === "https:" ? "; Secure" : ""}`;
        sync(false);
      } else {
        // Not consented: what an earlier visit left on the device and on the cart goes. Looked for
        // once per page; the tab's records are kept until a clear succeeded, so a clear lost with
        // the closing page is found by the next one.
        if (!looked) {
          looked = true;
          cookie = readCookie(host, VISITOR_COOKIE) !== undefined;
          if (cookie || session()?.getItem(SYNCED_KEY) || session()?.getItem(OPEN_KEY)) {
            pendingClear = true;
          }
        }
        if (hadId) pendingClear = true;
        // Deleted only where there is something to delete.
        if (cookie) {
          cookie = false;
          host.document.cookie = `${VISITOR_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
        }
        if (pendingClear) sync(true);
      }
    } catch (error) {
      // A browser that refuses cookies: the cart attribute is a bonus, never a failure.
      warn("the visitor's id could not be shared with checkout", error);
    }
    if (!hooked) {
      hooked = true;
      const leave = () => {
        if (id || pendingClear) sync(true);
      };
      host.addEventListener("pagehide", leave);
      host.document.addEventListener("visibilitychange", () => {
        if (host.document.visibilityState === "hidden") leave();
      });
    }
  };
}
