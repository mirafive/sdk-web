/**
 * The only door to device storage. It stays shut until analytics consent opens it: without consent
 * the SDK must not read from or write to the device at all (TDDDG §25, docs/data-collection.md,
 * T0). Deleting is always allowed, because revoking consent must remove what was stored. The one
 * read below T1 is Shopify mode's (`consent: 'shopify'`, `shopify/storefront.ts`): once per page it
 * looks for MIRA's own cookie `mira_aid` and the tab's records `mira_cart` and `mira_cart_open`, and,
 * while a clear is pending, Shopify's `cart` cookie, only to delete the id and empty the cart's
 * attribute when consent is not given.
 */
export const KEYS = {
  anonymousId: "mira_aid",
  userId: "mira_uid",
  groupId: "mira_gid",
  queue: "mira_q",
} as const;

type Key = (typeof KEYS)[keyof typeof KEYS];

export interface Store {
  /** Opened on analytics consent, closed on revoke. */
  open: boolean;
  get(key: Key): string | null;
  set(key: Key, value: string | undefined): void;
  clear(): void;
}

export function createStore(getStorage: () => Storage | undefined): Store {
  // Storage access can throw (Safari private mode, sandboxed iframes, full quota).
  const safe = <T>(action: (storage: Storage) => T): T | undefined => {
    try {
      const storage = getStorage();
      return storage ? action(storage) : undefined;
    } catch {
      return undefined;
    }
  };

  const store: Store = {
    open: false,
    get: (key) => (store.open ? (safe((storage) => storage.getItem(key)) ?? null) : null),
    set(key, value) {
      if (!store.open) return;
      safe((storage) =>
        value === undefined ? storage.removeItem(key) : storage.setItem(key, value),
      );
    },
    clear() {
      safe((storage) => {
        for (const key of Object.values(KEYS)) storage.removeItem(key);
      });
    },
  };
  return store;
}
