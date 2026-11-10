# Changelog

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
