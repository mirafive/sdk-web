/**
 * Behavior autocapture (docs/data-collection.md, 4. Behavior): engaged time, scroll depth,
 * outbound clicks, file downloads and form submits. These are events about the page, so they are
 * T0; nothing here touches device storage. Every listener is passive and swallows its own errors.
 */
import type { Host } from "./consent/types";

/** Paths ending in one of these are downloads. */
export const DOWNLOAD_EXTENSIONS = [
  "pdf",
  "zip",
  "dmg",
  "exe",
  "msi",
  "pkg",
  "csv",
  "xlsx",
  "xls",
  "docx",
  "doc",
  "pptx",
  "ppt",
  "txt",
  "rtf",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "wav",
  "epub",
  "apk",
  "gz",
  "tar",
  "7z",
  "rar",
  "iso",
  "json",
  "xml",
] as const;
const DOWNLOADS = new Set<string>(DOWNLOAD_EXTENSIONS);

/** Scroll depth is reported in these steps only, highest first. */
const DEPTHS = [100, 75, 50, 25] as const;
/** Scroll events fire many times a second; depth is measured at most this often. */
const SCROLL_THROTTLE_MS = 100;

export type BehaviorEvent = "$outbound_click" | "$file_download" | "$form_submit";
export type Emit = (event: BehaviorEvent, properties: Record<string, string | undefined>) => void;

export interface EngagementNumbers {
  engaged_ms: number;
  scroll_depth: number;
}

export interface Engagement {
  /**
   * The time engaged since the last call, and the deepest scroll step of this page. `measure`
   * reads the scroll position first (on page hide); on an SPA navigation the DOM already shows
   * the next page, so it must not be measured.
   */
  take(measure: boolean): EngagementNumbers;
  /** A new page view starts: time and depth start over. */
  restart(): void;
}

interface ElementLike {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selector: string): ElementLike | null;
}

const isElement = (value: unknown): value is ElementLike =>
  typeof value === "object" &&
  value !== null &&
  "closest" in value &&
  typeof value.closest === "function";

/** Origin and path only: query strings and hashes can carry personal data. */
const bare = (url: URL) => `${url.origin}${url.pathname}`;
/** `www.shop.example` and `shop.example` are the same site. */
const site = (hostname: string) => hostname.replace(/^www\./, "");

const extensionOf = (name: string) => {
  const file = name.slice(name.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  const extension = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
  return extension.length <= 10 ? extension : "";
};

/**
 * Engaged time counts while the document is visible and pauses while it is hidden. Scroll depth
 * is the deepest of 25 / 50 / 75 / 100 % the person reached on the current page.
 */
export function watchEngagement(host: Host): Engagement {
  const document = host.document;
  const visible = () => document.visibilityState === "visible";
  let total = 0;
  let since: number | undefined;
  let depth = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const measure = () => {
    const height = document.documentElement?.scrollHeight;
    if (!height) return;
    const percent = Math.round((((host.scrollY || 0) + (host.innerHeight || 0)) / height) * 100);
    depth = Math.max(depth, DEPTHS.find((step) => percent >= step) ?? 0);
  };
  const restart = () => {
    total = 0;
    since = visible() ? Date.now() : undefined;
    depth = 0;
    measure();
  };

  host.addEventListener(
    "scroll",
    () => {
      pending ??= setTimeout(() => {
        pending = undefined;
        try {
          measure();
        } catch {
          // A detached document: keep the depth we have.
        }
      }, SCROLL_THROTTLE_MS);
    },
    { passive: true },
  );
  document.addEventListener("visibilitychange", () => {
    if (visible()) since ??= Date.now();
    else if (since !== undefined) {
      total += Date.now() - since;
      since = undefined;
    }
  });
  restart();

  return {
    take(measureNow) {
      if (measureNow) measure();
      const now = Date.now();
      const engaged = total + (since === undefined ? 0 : now - since);
      total = 0;
      since = visible() ? now : undefined;
      return { engaged_ms: Math.max(0, Math.round(engaged)), scroll_depth: depth };
    },
    restart,
  };
}

/**
 * Delegated listeners on the document for link clicks and form submits, in the capture phase, so
 * they see the event even when the page stops it. Form field values are never read: only the
 * form's `id` and `name` attributes and the path of its action.
 */
export function watchInteractions(
  host: Host,
  flags: { outbound: boolean; downloads: boolean; forms: boolean },
  emit: Emit,
): void {
  const document = host.document;
  const options = { capture: true, passive: true };

  const onClick = (event: Event) => {
    try {
      // Middle clicks open links too, but fire `auxclick` instead of `click`.
      if (event.type === "auxclick" && "button" in event && event.button !== 1) return;
      const target = event.target;
      const link = isElement(target) ? target.closest("a[href],area[href]") : null;
      const href = link?.getAttribute("href");
      if (!link || !href) return;
      const url = new URL(href, host.location.href);
      // mailto:, tel:, javascript:, and blob: or data: downloads, which can hold the data itself.
      if (url.protocol !== "https:" && url.protocol !== "http:") return;

      const download = link.hasAttribute("download");
      const extension =
        extensionOf(url.pathname) ||
        (download ? extensionOf(link.getAttribute("download") ?? "") : "");
      if (flags.downloads && (download || DOWNLOADS.has(extension))) {
        emit("$file_download", { url: bare(url), extension: extension || undefined });
        return;
      }
      const domain = site(url.hostname);
      if (flags.outbound && domain !== site(new URL(host.location.href).hostname)) {
        emit("$outbound_click", { url: bare(url), domain });
      }
    } catch {
      // An unparsable href: nothing to report, and never an error in the page.
    }
  };

  const onSubmit = (event: Event) => {
    try {
      const form = event.target;
      if (!isElement(form)) return;
      // Attributes, not `form.id` or `form.action`: a field named "id" or "action" shadows those.
      const action = new URL(form.getAttribute("action") || host.location.href, host.location.href);
      emit("$form_submit", {
        form_id: form.getAttribute("id") || undefined,
        form_name: form.getAttribute("name") || undefined,
        action: action.pathname,
      });
    } catch {
      // Never an error in the page.
    }
  };

  if (flags.outbound || flags.downloads) {
    document.addEventListener("click", onClick, options);
    document.addEventListener("auxclick", onClick, options);
  }
  if (flags.forms) document.addEventListener("submit", onSubmit, options);
}
