import { describe, expect, test } from "bun:test";

import { fakeHost } from "../test/fake-host";
import { autoConsent } from "./auto";
import { consentMode, fromDataLayer } from "./consent-mode";
import { fromCmpData } from "./consentmanager";
import { cookiebot } from "./cookiebot";
import { fromPurposes, fromTcData, tcf, type TcData } from "./tcf";
import type { ConsentStatus } from "./types";
import { fromV2, fromV3 } from "./usercentrics";

/** What gtag() pushes onto the dataLayer: its `arguments` object, not an array. */
function args(..._values: unknown[]) {
  // oxlint-disable-next-line prefer-rest-params -- this is exactly what gtag pushes
  return arguments;
}

const all = (from: number, to: number) =>
  Object.fromEntries(Array.from({ length: to - from + 1 }, (_, index) => [from + index, true]));

describe("TCF 2.2", () => {
  test("accept all grants both purposes", () => {
    expect(fromPurposes(all(1, 11))).toEqual({ analytics: "granted", marketing: "granted" });
  });

  test("measurement without ads purposes is analytics only", () => {
    expect(fromPurposes({ 1: true, 8: true, 9: true })).toEqual({
      analytics: "granted",
      marketing: "denied",
    });
  });

  test("measurement without storage (purpose 1) is not analytics consent", () => {
    expect(fromPurposes({ 8: true, 9: true })).toEqual({
      analytics: "denied",
      marketing: "denied",
    });
  });

  test("partial ad purposes deny marketing", () => {
    expect(fromPurposes({ 1: true, 2: true, 7: true, 9: true }).marketing).toBe("denied");
  });

  test("an open banner is unknown; GDPR not applying is granted", () => {
    expect(fromTcData({ eventStatus: "cmpuishown", gdprApplies: true })).toEqual({
      analytics: "unknown",
      marketing: "unknown",
    });
    expect(fromTcData({ gdprApplies: false })).toEqual({
      analytics: "granted",
      marketing: "granted",
    });
  });

  test("follows __tcfapi addEventListener", () => {
    let listener: ((data: TcData, success: boolean) => void) | undefined;
    const fake = fakeHost({
      extra: {
        __tcfapi: (
          command: string,
          _version: number,
          callback: (data: TcData, ok: boolean) => void,
        ) => {
          if (command === "addEventListener") listener = callback;
        },
      },
    });
    const seen: ConsentStatus[] = [];
    expect(tcf.detect(fake.host)).toBe(true);
    tcf.subscribe(fake.host, (status) => seen.push(status));
    listener?.({ eventStatus: "cmpuishown", gdprApplies: true, listenerId: 1 }, true);
    listener?.(
      {
        eventStatus: "useractioncomplete",
        gdprApplies: true,
        purpose: { consents: { 1: true, 9: true } },
      },
      true,
    );
    expect(seen).toEqual([
      { analytics: "unknown", marketing: "unknown" },
      { analytics: "granted", marketing: "denied" },
    ]);
  });
});

describe("Google Consent Mode v2", () => {
  test("defaults only (denied) are unknown, not an answer", () => {
    const layer = [
      args("consent", "default", { analytics_storage: "denied", ad_storage: "denied" }),
    ];
    expect(fromDataLayer(layer)).toEqual({ analytics: "unknown", marketing: "unknown" });
  });

  test("updates map analytics_storage and ad_storage + ad_user_data", () => {
    const layer = [
      args("consent", "default", {
        analytics_storage: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
      }),
      args("consent", "update", {
        analytics_storage: "granted",
        ad_storage: "granted",
        ad_user_data: "denied",
      }),
    ];
    expect(fromDataLayer(layer)).toEqual({ analytics: "granted", marketing: "denied" });
  });

  test("no consent commands means no Consent Mode", () => {
    expect(fromDataLayer([{ event: "gtm.js" }])).toBeUndefined();
  });

  test("sees updates pushed after subscribing", () => {
    const dataLayer: unknown[] = [args("consent", "default", { analytics_storage: "denied" })];
    const fake = fakeHost({ extra: { dataLayer } });
    const seen: ConsentStatus[] = [];
    consentMode.subscribe(fake.host, (status) => seen.push(status));
    dataLayer.push(args("consent", "update", { analytics_storage: "granted" }));
    expect(seen.at(-1)?.analytics).toBe("granted");
  });
});

describe("Cookiebot", () => {
  test("waits for a response, then maps statistics and marketing", () => {
    const bot = { hasResponse: false, consent: { statistics: false, marketing: false } };
    const fake = fakeHost({ extra: { Cookiebot: bot } });
    const seen: ConsentStatus[] = [];
    cookiebot.subscribe(fake.host, (status) => seen.push(status));
    Object.assign(bot, { hasResponse: true, consent: { statistics: true, marketing: false } });
    fake.host.dispatchEvent(new Event("CookiebotOnAccept"));
    expect(seen).toEqual([
      { analytics: "unknown", marketing: "unknown" },
      { analytics: "granted", marketing: "denied" },
    ]);
  });
});

describe("Usercentrics", () => {
  test("v3: a MIRA FIVE service decides both purposes", () => {
    expect(
      fromV3({
        consent: { type: "EXPLICIT" },
        services: { abc: { name: "MIRA FIVE", consent: { given: true } } },
        categories: { marketing: { state: "ALL_DENIED" } },
      }),
    ).toEqual({ analytics: "granted", marketing: "granted" });
  });

  test("v3: implicit consent means the person has not answered", () => {
    expect(fromV3({ consent: { type: "IMPLICIT" } })).toEqual({
      analytics: "unknown",
      marketing: "unknown",
    });
  });

  test("v2: categories, analytics follows marketing without a statistics category", () => {
    expect(
      fromV2([
        { name: "GA", categorySlug: "marketing", consent: { status: true } },
        { name: "Hotjar", categorySlug: "functional", consent: { status: false } },
      ]),
    ).toEqual({ analytics: "granted", marketing: "granted" });
  });
});

describe("consentmanager", () => {
  test("no consent string yet is unknown; TCF purposes use the TCF mapping", () => {
    expect(fromCmpData({ consentstring: "" })).toEqual({
      analytics: "unknown",
      marketing: "unknown",
    });
    expect(fromCmpData({ consentstring: "CP...", purposeConsents: { 1: true, 8: true } })).toEqual({
      analytics: "granted",
      marketing: "denied",
    });
  });
});

describe("auto detection", () => {
  test("prefers a real CMP over the Consent Mode fallback", () => {
    const fake = fakeHost({
      extra: {
        dataLayer: [args("consent", "update", { analytics_storage: "denied" })],
        Cookiebot: { hasResponse: true, consent: { statistics: true, marketing: true } },
      },
    });
    const seen: string[] = [];
    const stop = autoConsent(fake.host, (_status, adapter) => seen.push(adapter));
    stop();
    expect(seen).toEqual(["cookiebot"]);
  });
});
