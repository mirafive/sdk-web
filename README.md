# @mirafive/web

The MIRA FIVE browser SDK: consent-aware analytics and revenue attribution for websites and web
apps. It follows the site's consent banner on its own, works cookieless until consent is given,
captures pageviews (also in single-page apps), engagement, outbound clicks, downloads and form
submits, and never throws into your page. About 11 kB gzip with every consent adapter; no
dependencies besides `@mirafive/protocol`. For a project that records sessions, a separate
recorder file (about 29 kB gzip) loads only when the server records the visit and the visitor
allows analytics; for a project that detects behavior signals, a separate detector file (about
7 kB gzip) loads when the server says so.

Using a framework? [`@mirafive/react`](https://github.com/mirafive/sdk-react),
[`@mirafive/next`](https://github.com/mirafive/sdk-next),
[`@mirafive/tanstack`](https://github.com/mirafive/sdk-tanstack),
[`@mirafive/vue`](https://github.com/mirafive/sdk-vue),
[`@mirafive/nuxt`](https://github.com/mirafive/sdk-nuxt) and
[`@mirafive/astro`](https://github.com/mirafive/sdk-astro) wrap this package. Server events and
revenue come from [`@mirafive/node`](https://github.com/mirafive/sdk-node) or
[PHP](https://github.com/mirafive/sdk-php).

## Install

### Script tag

```html
<script>
  window.mira =
    window.mira ||
    function () {
      (mira.q = mira.q || []).push(arguments);
    };
</script>
<script
  async
  src="https://cdn.mirafive.io/sdk/mira.js"
  data-host="https://events.mirafive.io"
  data-key="mira_pk_…"
></script>
```

The inline script is a stub: calls such as `mira('track', 'signup_started')` made before the SDK has
loaded are queued and replayed in order.

| Attribute          | Default                 | Meaning                                                                                    |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------ |
| `data-key`         | (required)              | The project's public key                                                                   |
| `data-host`        | the script's own origin | Ingest origin. Serve the script through your own domain and events go there too.           |
| `data-consent`     | `auto`                  | `auto` (follow the CMP), `granted`, `denied`, or `analytics` (analytics yes, marketing no) |
| `data-autocapture` | `true`                  | `false` turns off all automatic events                                                     |
| `data-spa`         | `true`                  | `false` turns off pageviews on client-side navigation                                      |
| `data-engagement`  | `true`                  | `false` turns off `$engagement`                                                            |
| `data-outbound`    | `true`                  | `false` turns off `$outbound_click`                                                        |
| `data-downloads`   | `true`                  | `false` turns off `$file_download`                                                         |
| `data-forms`       | `true`                  | `false` turns off `$form_submit`                                                           |

```js
mira("track", "signup_started", { plan: "pro" });
mira("identify", "user_42", { email: "ada@example.com", plan: "pro" });
// The same person in other systems, so connectors can link their money to this user:
mira("identify", "user_42", {}, { externalIds: { stripe_customer: "cus_123" } });
mira("group", "acme", { name: "Acme GmbH" });
mira("survey", { source: "podcast", answer: "The Elternzeit podcast" }); // "How did you hear about us?"
mira("page"); // manual pageview
mira("page", { status: 404 }); // on your not-found page: marks the page view as a 404
mira("setLocation", { latitude: 52.52, longitude: 13.4 }); // a location your site already has
mira("setLocation", null); // forget it
mira("consent", { analytics: true, marketing: false }); // custom banners
mira("consent", "auto"); // follow the CMP again
mira("reset"); // on logout
mira("flush"); // send now
```

### npm

```sh
npm install @mirafive/web   # or: bun add, pnpm add, yarn add
```

```ts
import { createMira } from "@mirafive/web";

export const mira = createMira({
  key: "mira_pk_…",
  host: "https://events.mirafive.io", // default
  consent: "auto", // or { analytics, marketing }
  // Default: everything on. `autocapture: false` turns everything off.
  autocapture: {
    pageviews: true,
    spa: true,
    engagement: true,
    outbound: true,
    downloads: true,
    forms: true,
  },
});

mira.track("signup_started", { plan: "pro" });
await mira.flush();
```

To keep the bundle smaller, pass only the CMP adapters you need:
`createMira({ key, adapters: [cookiebot] })` (`import { cookiebot } from "@mirafive/web"`).

### Typed events

Pass your events once and get autocomplete and checks for every `track` call:

```ts
type Events = {
  signup_started: { plan: "free" | "pro" };
  report_exported: { format: "csv" | "pdf" };
};

export const mira = createMira<Events>({ key: "mira_pk_…" });
mira.track("signup_started", { plan: "pro" }); // ✓
mira.track("signup_started", { plan: "gold" }); // type error
```

### "How did you hear about us?"

A survey answer is a touchpoint the attribution models credit like a visit:

```ts
mira.survey({ source: "podcast", answer: "The Elternzeit podcast" });
mira.survey({ channel: "organic_social", source: "instagram" });
```

### Joining server events to the visit

Server events (a paid invoice, a confirmed order) belong to the visitor who caused them. Send the
browser's anonymous id along, and set it as `anonymousId` on the server event:

```ts
await fetch("/api/checkout", {
  method: "POST",
  body: JSON.stringify({ cart, anonymousId: mira.anonymousId }),
});
```

`mira.anonymousId` is `undefined` without analytics consent; the event then counts without being
linked to the visit.

## API

| Member                                                       | What it does                                                                                                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMira<Events>(options?)`                               | Creates the client. Without options, call `init(options)` later; calls before that are kept.                                                                                                    |
| `track(name, properties?)`                                   | A custom event. Names starting with `$` are reserved.                                                                                                                                           |
| `page(properties?)`                                          | A manual pageview, for example `{ status: 404 }`.                                                                                                                                               |
| `identify(userId, traits?, { externalIds }?)`                | Who the user is. Traits like `email` are encrypted at rest. `externalIds` (`stripe_customer`, `revenuecat_app_user`, `shopify_customer`, `shopware_customer`) link connector money to the user. |
| `group(groupId, traits?)`                                    | The company or account (B2B).                                                                                                                                                                   |
| `survey({ source \| channel, answer?, medium?, campaign? })` | A survey answer as a touchpoint.                                                                                                                                                                |
| `consent("auto" \| "shopify" \| { analytics, marketing })`   | Follow the CMP (`"shopify"`: Shopify's consent, see Shopify), or set the state from a custom banner.                                                                                            |
| `setLocation({ latitude, longitude } \| null)`               | A location the site already has, rounded to about 1 km, only with consent.                                                                                                                      |
| `reset()`                                                    | On logout: forgets the user and starts a new anonymous id.                                                                                                                                      |
| `flush()`                                                    | Sends now. Resolves when done; never rejects.                                                                                                                                                   |
| `status`                                                     | The consent the SDK works with (`{ analytics, marketing }`).                                                                                                                                    |
| `anonymousId`                                                | The visitor's id with analytics consent, else `undefined`.                                                                                                                                      |
| `createNoopMira()`                                           | A client that does nothing, for tests and server rendering.                                                                                                                                     |
| `eventIdFor(key)`                                            | A stable event id from your own key (`order:123:paid`).                                                                                                                                         |

`createMira` refuses a secret key (`mira_sk_…`): it logs an error, even without `debug`, and
sends nothing.

## Automatic events

| Event             | When                                                                              | Properties                                                                    |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `$pageview`       | On load and on each client-side navigation                                        | Your own, through `mira('page', …)`                                           |
| `$engagement`     | When the person leaves a page (next SPA page, tab hidden, page closed); not < 1 s | `engaged_ms` (time the page was visible), `scroll_depth` (0, 25, 50, 75, 100) |
| `$outbound_click` | A click on a link to another site (`www.` does not count as another site)         | `url` (origin and path, no query or hash), `domain`                           |
| `$file_download`  | A click on a link to a file (PDF, ZIP, CSV, …) or with a `download` attribute     | `url` (origin and path), `extension`                                          |
| `$form_submit`    | A form is submitted                                                               | `form_id`, `form_name`, `action` (path only). **Never field values.**         |

These events describe the page, not the device, so they are sent at every tier (T0 too). If a
person comes back to a hidden tab, the next `$engagement` carries only the time since the last
one, so `engaged_ms` adds up per page view.

Each `$engagement` names its page view (`page_event_id`, the `event_id` of that `$pageview`), so
the time counts for the visit the page view belongs to, also when a tab is shown again an hour
later. It is the id of an event the page already sent, not an identifier of the person, and it is
left out once consent changed or `reset()` was called on that page.

### Behavior signals

Where visitors struggle, for a project that has them on (on by default; the project's Settings,
Traffic). The first batch's answer carries the definitions' numbers (`signals`,
`@mirafive/protocol` 2.6.0); only then does the SDK load its detector, a file of its own:
`mira-signals@<version>.js` beside the script tag, pinned by an integrity hash in `mira.js`, or a
chunk that `createMira` imports dynamically. `autocapture: false` (or `data-autocapture="false"`)
turns it off on the page; `autocapture: { signals: false }` turns off this part alone.

| Event           | When (the server's numbers, these are the defaults)                                                                                                                                       | Properties                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `$rage_click`   | 4 or more clicks within 30 px, each within 600 ms of the last, of which the page answered at most one                                                                                     | `selector`, `label`, `clicks`                                                              |
| `$dead_click`   | A click on something that looks clickable, then nothing for 1 s: no change in the page, no navigation, no request, no focus, no scrolling. A link that leaves the page by itself never is | `selector`, `label`                                                                        |
| `$form_abandon` | A form got input and the page was left (or the SPA route changed) without a submit or a request after the last input                                                                      | `form`, `form_id`, `form_name`, `field` (name or label, **never a value**), `fields`, `ms` |
| `$error`        | An uncaught exception, an unhandled rejection, or a request to your own site answered 400 or above; never an extension's error, an abort or another site's request                        | `kind`, `message`, `source` or `url` (origin and path), `method`, `status`                 |
| `$slow_page`    | LCP over 4 s, INP over 500 ms or CLS over 0.25, once per page view                                                                                                                        | `lcp_ms`, `inp_ms`, `cls`, `poor`                                                          |

Signals describe the page and read nothing from the device, so they are sent at every tier (T0
too) and store nothing. A label is the element's visible text, `aria-label`, `title` or `alt`,
through the PII guard; on pages the project marks sensitive, in strict masking and inside
`data-mira-mask` or `data-mira-block` no label or message is sent. Never in the page's way:
passive listeners, the work done after a click rather than during it, `fetch` and
`XMLHttpRequest` wrapped as a side branch, every error swallowed, and at most 10 of a kind and 25
in all per page view, 50 per document. The server derives quick backs itself.

### Events that start no visit

A visit needs an interaction. `$engagement` and the behavior signals never start one. If your own code sends an event
without the person doing anything (a timer, a video that keeps playing in a background tab), mark
it, and it will not open a visit either:

```ts
mira.track("video_progress", { percent: 50, $non_interaction: true });
```

## What is collected at each consent tier

|                                                        | T0: no analytics consent (`unknown`, `denied`)  | T1: analytics consent                                                                                                                                                   | T2: T1 + `identify` | T3: + marketing consent |
| ------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------- |
| Device storage (cookies, localStorage, sessionStorage) | **never read or written**                       | `mira_aid`, `mira_uid`, `mira_gid`, and the unsent queue (`mira_q`) in localStorage; `mira_replay` and `mira_replay_live` in sessionStorage while a session is recorded | same                | same                    |
| `anonymous_id`                                         | no                                              | yes (UUIDv7)                                                                                                                                                            | yes                 | yes                     |
| `user_id`, `group_id`, traits                          | no (kept in memory, sent once consent is given) | no `user_id` until `identify`                                                                                                                                           | yes                 | yes                     |
| `session_id`                                           | no (sessions are made by the server)            | no                                                                                                                                                                      | no                  | no                      |
| Page URL, referrer, title                              | yes                                             | yes                                                                                                                                                                     | yes                 | yes                     |
| Locale (`navigator.language`)                          | no (the server reads `Accept-Language`)         | yes (`de-DE`)                                                                                                                                                           | yes                 | yes                     |
| Screen, viewport, pixel ratio, languages, time zone    | no                                              | yes                                                                                                                                                                     | yes                 | yes                     |
| Client hints (device model, OS version)                | no (never asked for)                            | yes, asked once after consent                                                                                                                                           | yes                 | yes                     |
| Location from `setLocation`                            | no (kept in memory only)                        | yes, rounded to 2 decimals                                                                                                                                              | yes                 | yes                     |
| External ids (`identify` options)                      | no (kept in memory, sent once consent is given) | with `identify`                                                                                                                                                         | yes                 | yes                     |
| `consent` stamp on every event                         | yes                                             | yes                                                                                                                                                                     | yes                 | yes                     |
| Click ids kept by the server                           | no                                              | no                                                                                                                                                                      | no                  | yes                     |

IP and user agent are request data. The server turns the IP into geo at ingest and discards it.

**Consent changes take effect on the next event, without a reload.** When analytics consent is
granted in the middle of a visit, the SDK creates the `anonymous_id` and sends `$consent_changed`;
the server links the cookieless session to it, so the visit keeps its source. When consent is
revoked, the SDK deletes everything it stored and is cookieless again. Marketing consent only
changes the stamp.

**Global Privacy Control:** if `navigator.globalPrivacyControl` is `true`, marketing is treated as
denied. GPC is a legally binding opt-out of selling or sharing in several US states, and marketing
consent exists to share data with ad platforms. Analytics stays the CMP's decision. Do Not Track is
not read: it has no legal weight, and the CMP is where the person decides.

## Session recording

When a project records sessions, the server decides which visits are recorded, never the page: the
answer to a batch says so (`replay`, in `@mirafive/protocol`). Only then, and only with analytics
consent, does the SDK load the recorder. A visit below analytics consent loads nothing, records
nothing and buffers nothing, and no request goes to the recording routes.

- **Loading:** the script tag loads `mira-recorder@<version>.js` of its own release from beside
  itself (`/sdk/mira.js`, `/sdk/v2/mira.js` and `/sdk/mira@2.3.0.js` all load
  `/sdk/mira-recorder@2.3.0.js`), checked by the integrity hash `mira.js` carries, so a page that
  pins `mira.js` with Subresource Integrity pins the recorder too. A first-party proxy must forward
  that file like the script; a copied, self-hosted `mira.js` without it records nothing. With npm,
  `createMira` loads it with a dynamic `import()`, which your bundler splits into a chunk of its
  own. The recorder is `@rrweb/record` 2.2.2, bundled into that file and chunk (MIT; its license is
  in them), so the package has no dependency on it.
- **Across pages and tabs:** the decision, the tab's id and its chunk numbers are kept in the
  tab's `sessionStorage` (`mira_replay`), so the next page of a site that loads a document per page
  records from its first moment, in the same stream. Each tab is a stream of its own (the
  visitor's tabs share the session): it has a random id and numbers its chunks from 0. A tab the
  browser made as a copy of another open tab (duplicated, `window.open`, a link with an opener)
  copies its `sessionStorage` too; `mira_replay_live`, set while a page of the tab records and
  removed on `pagehide`, tells such a copy to record as a new tab. On the first page of a visit the recording starts with the first batch's answer,
  about 2 seconds after load, with a full picture of the page as it is then. A batch sent by
  `sendBeacon` gets no answer; the next page's first batch brings it.
- **Masked in the browser:** every form input shows a fixed `***` (an empty one stays empty), so
  lengths do not leak; hidden inputs too. Passwords, payment fields (`autocomplete="cc-…"`) and
  one-time codes are replaced by a placeholder of their size, and no setting can unmask them.
  `data-mira-mask` masks an element's text, `data-mira-block` replaces an element, `data-mira-ignore`
  drops its input events. The project chooses `standard` (text masked on its sensitive pages) or
  `strict` (text masked everywhere) and pages that are never recorded; single-page navigations
  are checked against both on every recorded event. All other text, and attribute values that can
  hold what a person typed (`title`, `alt`, `placeholder`, `aria-*`, `data-*`, `value`, `href`),
  pass the PII guard of `@mirafive/protocol` (`redactPii`: emails, IBANs, phone numbers, card
  numbers); a `mailto:` or `tel:` link keeps only its scheme. No canvas, no fonts, no images
  inlined, no frame's `src`, no frames of other origins. Stylesheets of browser extensions are
  dropped.
- **Problems on the timeline:** console errors, uncaught exceptions and failed requests (method,
  the URL's origin and path, status, duration; never a body, header or query) are recorded beside
  the page, through the same guard, at most 100 per page.
- **Sent in chunks:** a page's full snapshot at once, then a chunk every 30 seconds or at 256 KB,
  gzipped by the browser's `CompressionStream` and sent one at a time as a CORS simple request
  (`POST /v1/replay`, everything in the URL). On page hide the rest goes in a beacon. A browser
  without `CompressionStream` (before 2023) records nothing. A refusal stops recording for the
  page (`401`, `402`, `403`, a second `429` or `503`) or the session (`409`); a `400` or `413`
  takes a new full snapshot, and a slow or failing upload drops the recording and nothing else.
- **Consent withdrawn** during a visit: the recorder stops, drops what it has, the tab's record
  goes, and the SDK asks the server to delete the session's recording
  (`POST /v1/replay/withdraw`). Every consent adapter and `consent()` work the same way.
- **Never in the way:** recording starts and events are turned into chunks when the browser is
  idle, every listener is passive, every error is swallowed. The one cost a page notices is the
  full snapshot, a single task that grows with the page: about 10 ms for 4,500 nodes and 230 ms
  for 27,000 on a phone-speed CPU. Nothing is loaded or recorded while a page is prerendered or
  hidden since it opened (a background tab) until it is shown.

## Consent banners (`consent: 'auto'`)

The SDK looks for these CMPs in this order and follows the first one it finds. Until the CMP
answers, the state is `unknown` (T0). The first automatic pageview waits up to 1 s for that answer,
so a returning visitor's pageview already carries their consent.

| CMP                               | Read through                                                                     | Mapping                                                                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usercentrics v3                   | `__ucCmp.getConsentDetails()`, `UC_CONSENT` event                                | A service named "MIRA FIVE" decides both. Otherwise a `statistics`/`analytics`/`performance` category → analytics (else analytics follows `marketing`); `marketing` → marketing. `IMPLICIT` consent = not answered. |
| Usercentrics v2                   | `UC_UI.getServicesBaseInfo()`, `UC_UI_INITIALIZED`, `UC_UI_CMP_EVENT`, `ucEvent` | Same as v3                                                                                                                                                                                                          |
| Cookiebot                         | `Cookiebot.consent`, `CookiebotOnConsentReady` / `OnAccept` / `OnDecline`        | statistics → analytics, marketing → marketing; no `hasResponse` = not answered                                                                                                                                      |
| consentmanager                    | `__cmp('getCMPData')`, `__cmp('addEventListener', ['consent', …])`               | TCF purposes as below; classic setups: c53 → analytics, c52 → marketing (check your purpose ids)                                                                                                                    |
| CCM19                             | `CCM.acceptedEmbeddings`, `ccm19WidgetClosed`                                    | Add MIRA FIVE as an embedding: accepted → analytics. A second embedding "MIRA FIVE Marketing" → marketing.                                                                                                          |
| Borlabs Cookie 3                  | `BorlabsCookie.Consents`, `borlabs-cookie-consent-saved`                         | `statistics` group (or a `mira-five` service) → analytics, `marketing` group → marketing                                                                                                                            |
| Shopify Customer Privacy API      | `Shopify.customerPrivacy`, `visitorConsentCollected`                             | `analyticsProcessingAllowed()` → analytics, `marketingAllowed()` → marketing; not allowed while `shouldShowBanner()` = not answered                                                                                 |
| Any TCF 2.2 CMP                   | `__tcfapi('addEventListener', 2, …)`                                             | analytics: purpose 1 and 8 or 9. marketing: purposes 1, 2, 3, 4 and 7. `gdprApplies: false` → both granted.                                                                                                         |
| Google Consent Mode v2 (fallback) | `gtag('consent', …)` commands in `dataLayer`                                     | `analytics_storage` → analytics; `ad_storage` and `ad_user_data` → marketing. A `default` of denied without an update = not answered. Used only after page load when no CMP was found.                              |

## Shopify

**Storefront.** Add `data-consent="shopify"` to the script tag (`consent: 'shopify'` with npm). It
follows Shopify's Customer Privacy API, so the shop's privacy settings and banner must be set up for
its regions: where they are not, Shopify answers "allowed" for everyone. A banner from the
table above that is on the page when the script starts (its script may still be loading) owns the
decision from the start, so Shopify's "allowed" never writes to the device before the visitor has
answered it. A banner that only appears later, through a tag manager, takes over then, after
Shopify's answer was already used and storage was written. Without the
option a Shopify page behaves like any other (no Shopify adapter, no cookie, no cart attribute).
With npm, `consent: 'shopify'` does the same; nothing else is needed.

With analytics consent the tag writes the visitor's id to the cookie `mira_aid` and to the cart
attribute `_mira_aid`. Shopify copies a cart attribute to the order (`note_attributes`), so a server
connector can join a guest's order to their visit. The name and the value (the bare anonymous id;
empty means none) are stable. The attribute is not private: it is in the theme's `cart.attributes`
and on the order in the admin. When consent is not given, also on a later page than the "yes", the
cookie is removed and the attribute emptied. Identify a logged-in customer in the theme, with a user id that names its source (a bare id could collide with your own user ids):

```liquid
{% if customer %}
  <script>mira('identify', 'shopify:{{ customer.id }}', {}, { externalIds: { shopify_customer: '{{ customer.id }}' } });</script>
{% endif %}
```

**Checkout.** The pixel can only see Shopify's own consent answer. A store with its own cookie banner
must connect it to Shopify's customer privacy settings (the banner reports its choice to Shopify)
before the pixel is added; otherwise a visitor who declined the banner can still count as allowed
in checkout. It runs in a sandbox where the script tag cannot run, so a custom pixel (Settings →
Customer events → Add custom pixel, permission "Not required") runs pixel mode. It is its own file,
`mira-shopify-pixel.js`, so the script every site loads stays small:

```js
window.mira =
  window.mira ||
  function () {
    (mira.q = mira.q || []).push(arguments);
  };
analytics.subscribe("all_standard_events", (event) => {
  mira("shopifyEvent", event);
});
mira("shopifyPixel", {
  init,
  browser,
  customerPrivacy: typeof api !== "undefined" ? api.customerPrivacy : undefined,
  key: "mira_pk_…",
});
const script = document.createElement("script");
script.async = true;
script.src = "https://cdn.mirafive.io/sdk/v2/mira-shopify-pixel.js";
document.head.appendChild(script);
```

The snippet subscribes to Shopify's events itself (Shopify's pixel editor warns about code without
an `analytics.subscribe` call) and hands each one to the script. Pixel mode takes the page from each event's `context.document`, the visitor's id from the storefront
cookie through `browser.cookie`, and consent from `init.customerPrivacy` and
`customerPrivacy.subscribe('visitorConsentCollected', …)`. It sends `product_viewed`,
`product_added_to_cart`, `checkout_started`, `payment_info_submitted` and `checkout_completed`
(`order_id`, `total` and `currency` as plain properties), and a `$pageview` for checkout pages. The
theme's script tag owns storefront pageviews; pass `pages: 'all'` in a shop without it. An event
waits until a page URL is known, because the pixel's requests carry `Origin: null` and the ingest
accepts those only with a page on the project's domains. It never sends money: a public key cannot
create revenue, so revenue comes from the shop's server.

## Delivery

- In-memory queue, batches of up to 50 events or every 2 s, `fetch` with `keepalive`.
- Every batch carries a random `stream` id per page load (memory only) and a `seq` from 1, so the
  server can count lost batches; a retry resends the same batch with the same `seq`.
- On `visibilitychange: hidden` and `pagehide`, the queue goes out with `navigator.sendBeacon` to
  `/v1/p` (`text/plain`, no CORS preflight).
- Network errors, 5xx and 429 are retried with exponential backoff and jitter, with the same
  `event_id`s (UUIDv7), so the server counts each event once. Other 4xx answers drop the batch.
- At most 1000 queued events and 24 hours of age. With analytics consent, unsent events are kept in
  localStorage and sent on the next page.
- Nothing is captured or sent while the page is prerendered.
- The SDK never throws into your page. Pass `debug: true` (or `data-debug="true"`) to see warnings.

## For AI coding assistants

Rules for integrating MIRA FIVE correctly. They hold for every MIRA FIVE SDK.

- **Keys:** the public key (`mira_pk_…`) goes in browser and app code. The secret key (`mira_sk_…`)
  goes only into the server's environment (`MIRAFIVE_SECRET_KEY`), never into client code, a
  `NEXT_PUBLIC_`/`VITE_`/`PUBLIC_` variable or a repository. The SDKs refuse the wrong key.
- **Money** is sent only from the server: integer minor units plus an ISO 4217 currency
  (`amount: 1999, currency: "EUR"` is 19.99 EUR), never floats.
- **Count once:** give money an `entryId` from the payment provider (`stripe:in_123`), so the
  Stripe connector and retries do not double it. Give business events a stable id:
  `eventId: await eventIdFor("order:123:paid")`. The same key gives the same id in every SDK.
- **Personal data** never goes into event names or properties. Use your own user id (not an email)
  for `identify`; put email, name and phone in its traits, which MIRA FIVE encrypts at rest.
- **Consent:** keep `consent: "auto"`; it follows the site's consent banner (Usercentrics,
  Cookiebot, consentmanager, CCM19, Borlabs, any TCF 2.2 CMP, Google Consent Mode). Call
  `consent()` only for a custom banner. Do not gate the SDK behind consent yourself: without
  consent it is cookieless and still counts.
- **Never block on analytics:** event methods return nothing, never throw, and batch on their
  own. Do not `await` or `try` them. Call `flush()`/`shutdown()` only at the end of a script or a
  serverless function.
- **Server events and visitors:** pass the browser's `mira.anonymousId` to your server and set it
  as `anonymousId` on server events, so a purchase joins the visit and its source.
