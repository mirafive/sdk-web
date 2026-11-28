/**
 * The script-tag entry, built to `dist/mira.js` and served at `/sdk/mira.js`.
 *
 * ```html
 * <script>
 *   window.mira = window.mira || function () { (mira.q = mira.q || []).push(arguments) };
 * </script>
 * <script async src="https://cdn.mirafive.io/sdk/mira.js" data-host="https://events.mirafive.io" data-key="mira_pk_…"></script>
 * ```
 *
 * Attributes on the script tag:
 * - `data-key` (required unless `mira('init', {...})` is queued): the project's public key.
 * - `data-host`: the ingest origin. Default: the origin the script was loaded from, so a
 *   first-party proxy works without extra settings.
 * - `data-consent`: `auto` (default, follow the CMP), `granted`, `denied`, or `analytics`
 *   (analytics granted, marketing denied).
 * - `data-consent="shopify"` on a Shopify storefront follows Shopify's consent (and any other
 *   banner that appears) and, with analytics consent, writes the visitor's id to a cookie and the
 *   cart attribute `_mira_aid`. Without it a Shopify page behaves like any other.
 * - `data-autocapture="false"`: turn off all autocapture. `data-spa`, `data-engagement`,
 *   `data-outbound`, `data-downloads`, `data-forms` set to `"false"` turn off one part. Behavior
 *   signals follow the project's setting; `data-autocapture="false"` turns them off too.
 */
import type { ConsentChoice, Host } from "./consent/types";
import { createMira, type Mira, type MiraOptions } from "./mira";
import { replayControl } from "./replay/control";
import { scriptLoader } from "./replay/script-loader";
import { siblingLoader } from "./sibling";
import { type CreateSignals, signalsControl } from "./signals/control";

/** The signals file's Subresource Integrity hash, set by the build (build.ts); none in tests. */
declare const MIRA_SIGNALS_INTEGRITY: string | undefined;

type Command =
  | "init"
  | "page"
  | "track"
  | "survey"
  | "identify"
  | "group"
  | "consent"
  | "setLocation"
  | "reset"
  | "flush";
type Stub = ((...args: unknown[]) => unknown) & { q?: ArrayLike<unknown>[] };

const CONSENT: Record<string, "auto" | "shopify" | ConsentChoice> = {
  auto: "auto",
  granted: { analytics: true, marketing: true },
  denied: { analytics: false, marketing: false },
  analytics: { analytics: true, marketing: false },
  shopify: "shopify",
};

function optionsFromScript(script: HTMLScriptElement | null): MiraOptions | undefined {
  const data = script?.dataset;
  if (!data?.key) return undefined;
  let origin: string | undefined;
  try {
    origin = script?.src ? new URL(script.src).origin : undefined;
  } catch {
    origin = undefined;
  }
  return {
    key: data.key,
    host: data.host || origin,
    consent: CONSENT[data.consent ?? "auto"] ?? "auto",
    autocapture:
      data.autocapture === "false"
        ? false
        : {
            pageviews: true,
            spa: data.spa !== "false",
            engagement: data.engagement !== "false",
            outbound: data.outbound !== "false",
            downloads: data.downloads !== "false",
            forms: data.forms !== "false",
          },
    debug: data.debug === "true",
  };
}

function boot() {
  const host = window as unknown as Record<string, unknown>;
  // Loaded twice (two tags, a tag manager replaying it): keep the first instance.
  if ((host.mira as { loaded?: boolean } | undefined)?.loaded) return;

  const stubQueue = Array.from((host.mira as Stub | undefined)?.q ?? []);
  // Only while this script runs for the first time does the page say where it came from.
  const script = document.currentScript as HTMLScriptElement | null;
  // The page's window, named so a test can stand in for it. A recorded session loads the recorder
  // file of this release from beside this script.
  const instance: Mira = createMira(
    undefined,
    window as unknown as Host,
    undefined,
    replayControl(scriptLoader(script?.src, document)),
    signalsControl(
      siblingLoader<CreateSignals>(
        script?.src,
        document,
        "signals",
        typeof MIRA_SIGNALS_INTEGRITY === "string" ? MIRA_SIGNALS_INTEGRITY : undefined,
      ),
    ),
  );

  const run = (command: Command, args: unknown[]): unknown => {
    const call = instance[command] as ((...values: unknown[]) => unknown) | undefined;
    if (typeof call !== "function") return undefined;
    return call(...args);
  };

  const mira = Object.assign((command: Command, ...args: unknown[]) => run(command, args), {
    loaded: true,
  });
  host.mira = mira;

  // Calls made before the script loaded, in order. `consent` and `init` from the stub queue still
  // win over the script attributes, because the instance applies them when it starts.
  for (const entry of stubQueue) {
    const [command, ...args] = Array.from(entry);
    if (command !== "init") run(command as Command, args);
  }
  const queuedInit = stubQueue.find((entry) => entry[0] === "init")?.[1] as MiraOptions | undefined;
  const options = queuedInit ?? optionsFromScript(script);
  if (options) {
    instance.init(options);
  }
}

try {
  boot();
} catch {
  // Never break the host page.
}
