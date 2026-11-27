# Changelog

## 2.3.0 — 2026-11-27

### Added

- Session recording, for projects that record sessions: the server's answer to a batch says
  whether this visit is recorded (`replay`, `@mirafive/protocol` 2.5.0), and only then, with
  analytics consent, the SDK loads its recorder, a separate file: `mira-recorder@<version>.js`
  beside the script tag (pinned by an integrity hash in `mira.js`), or a chunk that `createMira`
  imports dynamically. It records with `@rrweb/record` 2.2.2, bundled into it, so the package still
  depends on nothing but `@mirafive/protocol`. Masking happens in the browser: every input shows a
  fixed mask, passwords, payment fields and one-time codes are never recorded, `data-mira-mask`,
  `data-mira-block` and `data-mira-ignore`, the project's masking mode and page patterns, and the
  PII guard over text and attributes. Console errors, uncaught exceptions and failed requests are
  recorded beside the page. Chunks go one at a time in the background; a refusal or a slow upload
  stops the recording, never the page. Withdrawing analytics consent stops recording and asks the
  server to delete the session's recording. See the README, Session recording.
- The tab keeps `mira_replay` in `sessionStorage` while a session is recorded (T1 only), so the
  next page records from its first moment.
- The transport reads the body of a batch's `202`; until now it read only the status.

### Changed

- The script tag grew from 9.9 to 10.7 kB gzip (10,122 to 10,967 bytes): the answer, the consent
  hook and the loader; the recorder itself is 29 kB gzip in its own file. The pixel file is
  11.7 kB (11,785 to 11,954 bytes) and never records. CI's budget for the script tag is now 11 kB.
- Requires `@mirafive/protocol` 2.5.0.

## 2.2.0 — 2026-11-23

### Added

- Shopify, opt-in: `data-consent="shopify"` (`consent: 'shopify'`) follows the Customer Privacy API
  on a storefront. A banner on the page (even one still loading) decides instead and Shopify's
  answer is not used; one that appears later takes over then. It is never detected on its own, so a
  Shopify page without the option behaves as before.
- With the option and analytics consent, the tag writes the visitor's id to the cookie `mira_aid`
  and the cart attribute `_mira_aid` (the order's `note_attributes`; visible in the theme's
  `cart.attributes` and in the admin), so checkout and server connectors join the visit. Consent
  that is not given removes the cookie and empties the attribute, also on a later page or when the
  request was lost with the closing page (the tab keeps a record until a clear succeeded). Cart
  writes go through one queue, so the last wish wins.
- The script does not decide once whether Shopify's API is there. One that runs before Shopify's
  head scripts looks again at `DOMContentLoaded` and every 100 ms for five seconds, asks with
  `loadFeatures` when that is all there is (an error is logged once and the look goes on; an answer
  that comes later is still heard), and wires the cookie and cart attribute as soon as Shopify is
  there: at the first consent change, or at the page's `DOMContentLoaded` or `load` when a banner of
  another kind decided before Shopify's scripts ran. Wiring on the way to a "no" writes no id. Until the API answers, consent stays unknown and nothing is stored. A decision made
  before the script looked is read from the API's current state; after the five seconds only a new
  decision (or a late `loadFeatures` answer) is heard. A broken API is a warning, never an error.
- Pixel mode for Shopify custom pixels, its own file `mira-shopify-pixel.js` (also
  `startShopifyPixel`): `analytics.subscribe('all_standard_events', (event) => mira('shopifyEvent', event))` and `mira('shopifyPixel', { init, browser, customerPrivacy, key })`; an event gets the time Shopify gave it (within an hour of now). A signed-in customer is identified as `shopify:<id>` (theme and pixel alike), never the bare id, which could collide with the shop's own user ids.
  The page comes from each event's `context.document`, the visitor's id through `browser.cookie`,
  consent from `init.customerPrivacy` and `customerPrivacy.subscribe` (`api.customerPrivacy` in the
  pixel editor). Shopify's standard events are sent as `product_viewed`, `product_added_to_cart`,
  `checkout_started`, `payment_info_submitted` and `checkout_completed`, with no money: revenue
  comes from the shop's server. Pageviews are for checkout pages unless `pages: 'all'`.
- `onAnonymousId`, an option for platform integrations: called when analytics consent makes a
  visitor id or `reset` makes a new one, and with `undefined` whenever consent is denied.

### Changed

- The script tag grew from 8.4 to 9.9 kB gzip; the pixel file is 11.5 kB (its own build budget is 12 kB) (the Shopify adapter and the cart hook).
- `consent` also accepts `'shopify'`. A `consent` call made before `init` (also one queued before
  the script loaded) is now `init`'s own choice, not a call after it, so a CMP's or Consent Mode's
  grant cannot come first.

## 2.1.1 — 2026-11-23

### Fixed

- Types only: 2.1.0 changed the type of `track`'s properties, so code that forwards the properties
  of any event (`properties?: Events[Name]`) no longer compiled. `track` has its 2.0 signature
  again, and `$non_interaction` with typed events is a second overload. The script is unchanged.

## 2.1.0 — 2026-11-23

### Added

- Every `$engagement` names the page view it measures (`page_event_id`, the `event_id` of that
  `$pageview`). The server counts it for that page view's visit, also when a tab is shown again an
  hour later or the event is sent late from the saved queue. Nothing else changes, and a server
  before this field ignores it. After consent changes tier or `reset()` is called, an
  `$engagement` names no page view, so it never ties events across that line.
- `$non_interaction: true` keeps an event of your own from starting a visit. `track` accepts it
  with typed events too, and the README documents it.

### Changed

- Requires `@mirafive/protocol` 2.4.0, which adds the field.

## 2.0.3 — 2026-11-10

### Changed

- Requires `@mirafive/protocol` 2.3.0, which adds the types of the person erasure the server SDKs
  call. The browser SDK has no new method: erasing a person needs the secret key, which never
  belongs in a browser.

## 2.0.2 — 2026-11-10

### Changed

- Requires `@mirafive/protocol` 2.2.1 (was `^2.0.0`), so an install resolves the protocol it is
  tested with.
- Built and checked with oxfmt 0.78 and oxlint 1.93. The script tag is unchanged in behaviour.

## 2.0.1 — 2026-11-10

### Fixed

- Without analytics consent (T0), events no longer carry `context.locale`: the SDK does not read
  `navigator.language` at all until consent is given. The server takes a T0 visitor's language
  from the request's `Accept-Language`, as the consent tiers say. With analytics consent the
  locale is sent as before (`de-DE`), now capped at the protocol's 35 characters.

## 2.0.0 — 2026-11-08

A rewrite for the current MIRA FIVE platform: consent tiers, the revenue ledger, touchpoints and
the `/v1/batch` wire format.

### Added

- follows Usercentrics, Cookiebot, consentmanager, CCM19, Borlabs, any TCF 2.2 CMP and
  Google Consent Mode; Global Privacy Control; `survey()` touchpoints; `anonymousId` to join server
  events to the visit; typed event maps; refuses secret keys; the script tag with a stub queue.

### Migrating from 1.x

- **Keys:** projects have a public key (`mira_pk_…`, browser and apps) and a secret key
  (`mira_sk_…`, servers). `mf_…` website and secret keys are gone. Every SDK refuses the wrong
  kind of key with a clear message.
- **Host:** `https://events.mirafive.io` (was `collect.mirafive.io`).
- **Environment:** `MIRAFIVE_SECRET_KEY` and `MIRAFIVE_HOST` on servers; the public key as
  `NEXT_PUBLIC_MIRAFIVE_KEY`, `VITE_MIRAFIVE_KEY`, `PUBLIC_MIRAFIVE_KEY` (Astro),
  `NUXT_PUBLIC_MIRAFIVE_KEY` or `MIRAFIVE_PUBLIC_KEY` (PHP templates).
- **Consent:** there are no modes any more. The browser SDK follows the site's consent banner
  (`consent: "auto"`) and collects what each tier allows: cookieless without consent, an
  anonymous id with analytics consent, a user with `identify`. Server events carry the consent
  they were collected under (default `not_applicable`).
- **Revenue:** `revenue()` on the server SDKs, in integer minor units with an ISO currency,
  `entryId` (replaces `payment_id`), `entryKind`, fees, tax, refunds and subscriptions. Revenue
  properties on plain events are no longer read.
- **Plugins:** the browser SDK has no plugins. Pageviews, SPA navigation, engagement, outbound
  clicks, downloads and form submits are on by default and switched with `autocapture`.
