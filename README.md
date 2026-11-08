# @mirafive/web

The MIRA FIVE browser SDK: consent-aware analytics and revenue attribution for websites and web
apps. It follows the site's consent banner on its own, works cookieless until consent is given,
captures pageviews (also in single-page apps), engagement, outbound clicks, downloads and form
submits, and never throws into your page. About 8 kB gzip with every consent adapter; no
dependencies besides `@mirafive/protocol`.

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
| `consent("auto" \| { analytics, marketing })`                | Follow the CMP, or set the state from a custom banner.                                                                                                                                          |
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

## What is collected at each consent tier

|                                                        | T0: no analytics consent (`unknown`, `denied`)  | T1: analytics consent                                                               | T2: T1 + `identify` | T3: + marketing consent |
| ------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------- | ----------------------- |
| Device storage (cookies, localStorage, sessionStorage) | **never read or written**                       | `mira_aid`, `mira_uid`, `mira_gid`, and the unsent queue (`mira_q`) in localStorage | same                | same                    |
| `anonymous_id`                                         | no                                              | yes (UUIDv7)                                                                        | yes                 | yes                     |
| `user_id`, `group_id`, traits                          | no (kept in memory, sent once consent is given) | no `user_id` until `identify`                                                       | yes                 | yes                     |
| `session_id`                                           | no (sessions are made by the server)            | no                                                                                  | no                  | no                      |
| Page URL, referrer, title                              | yes                                             | yes                                                                                 | yes                 | yes                     |
| Locale                                                 | 2 letters (`de`), like `Accept-Language`        | full (`de-DE`)                                                                      | full                | full                    |
| Screen, viewport, pixel ratio, languages, time zone    | no                                              | yes                                                                                 | yes                 | yes                     |
| Client hints (device model, OS version)                | no (never asked for)                            | yes, asked once after consent                                                       | yes                 | yes                     |
| Location from `setLocation`                            | no (kept in memory only)                        | yes, rounded to 2 decimals                                                          | yes                 | yes                     |
| External ids (`identify` options)                      | no (kept in memory, sent once consent is given) | with `identify`                                                                     | yes                 | yes                     |
| `consent` stamp on every event                         | yes                                             | yes                                                                                 | yes                 | yes                     |
| Click ids kept by the server                           | no                                              | no                                                                                  | no                  | yes                     |

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
| Any TCF 2.2 CMP                   | `__tcfapi('addEventListener', 2, …)`                                             | analytics: purpose 1 and 8 or 9. marketing: purposes 1, 2, 3, 4 and 7. `gdprApplies: false` → both granted.                                                                                                         |
| Google Consent Mode v2 (fallback) | `gtag('consent', …)` commands in `dataLayer`                                     | `analytics_storage` → analytics; `ad_storage` and `ad_user_data` → marketing. A `default` of denied without an update = not answered. Used only after page load when no CMP was found.                              |

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
