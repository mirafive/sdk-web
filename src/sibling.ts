import { VERSION } from "./version";

/**
 * Files of the same release served beside the script tag's `mira.js` (the recorder, the signals
 * detector, the CMP adapters' subscriptions, Shopify mode's parts): where they are, where they
 * register, and how they load. One name per release, so files of two releases never mix.
 */

/** The siblings' Subresource Integrity hashes by name, set by the build (build.ts); none in tests. */
declare const MIRA_INTEGRITY: Readonly<Record<string, string>> | undefined;
const INTEGRITY: Readonly<Record<string, string>> =
  typeof MIRA_INTEGRITY === "object" ? MIRA_INTEGRITY : {};

/** Where a sibling file registers itself. */
export const siblingSlot = (name: string, version: string) =>
  Symbol.for(`mirafive.${name}@${version}`);

/**
 * The sibling of this release next to the script that is running: `/sdk/mira.js`,
 * `/sdk/v2/mira.js` and `/sdk/mira@2.3.0.js` all load `/sdk/mira-<name>@2.3.0.js`, the file that
 * never changes under its version. A first-party proxy forwards it like the script.
 */
export function siblingUrl(
  scriptSrc: string,
  name: string,
  version: string = VERSION,
): string | undefined {
  try {
    const url = new URL(scriptSrc);
    url.pathname = url.pathname.replace(/(?:v\d+\/)?[^/]*$/, `mira-${name}@${version}.js`);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Loads a sibling as a script beside this one, checked by its integrity hash, once. Its errors
 * carry no text: the base script stays small, and the caller says what failed.
 */
export function siblingLoader<T>(
  scriptSrc: string | undefined,
  document: Document,
  name: string,
  integrity: string | undefined = INTEGRITY[name],
): () => Promise<T> {
  let loading: Promise<T> | undefined;
  return () =>
    (loading ??= new Promise<T>((resolve, reject) => {
      const url = scriptSrc && siblingUrl(scriptSrc, name);
      if (!url) return reject();
      const script = document.createElement("script");
      script.src = url;
      script.crossOrigin = "anonymous";
      if (typeof integrity === "string") script.integrity = integrity;
      script.addEventListener("load", () => {
        const create = (globalThis as Record<symbol, T | undefined>)[siblingSlot(name, VERSION)];
        if (create) resolve(create);
        else reject();
      });
      script.addEventListener("error", () => reject());
      document.head.append(script);
    }));
}
