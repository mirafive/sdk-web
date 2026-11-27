/* oxlint-disable typescript/no-unsafe-type-assertion -- test fakes stand in for browser globals */
import { describe, expect, test } from "bun:test";

import type { ConsentAdapter, ConsentStatus } from "../consent/types";
import { createMira, type MiraOptions } from "../mira";
import { fakeHost, tick } from "../test/fake-host";
import { Transport } from "../transport";
import {
  REPLAY_KEY,
  replayControl,
  type CreateReplay,
  type ReplayEnvironment,
  type ReplaySession,
} from "./control";

const KEY = "mira_pk_test";
const HOST = "https://ingest.example";
const SESSION = "019ac6a4-1c2b-7d3e-8f40-123456789abc";
const replay = {
  session_id: SESSION,
  masking: "standard",
  never_record: [],
  sensitive: [],
} as const;

/** A recorder file that only notes what it was told. */
function fakeRecorder() {
  const calls: string[] = [];
  let loads = 0;
  let session: string | undefined;
  const environments: ReplayEnvironment[] = [];
  const create: CreateReplay = (environment) => {
    environments.push(environment);
    const handle: ReplaySession = {
      get sessions() {
        return session ? [session] : [];
      },
      answer(body) {
        const id = (body as { replay?: { session_id?: string } }).replay?.session_id;
        calls.push(`answer:${id ?? "none"}`);
        session = id;
      },
      consent: (granted) => calls.push(`consent:${granted}`),
      reset: () => calls.push("reset"),
      hide: () => calls.push("hide"),
    };
    return handle;
  };
  return {
    calls,
    environments,
    loads: () => loads,
    load: () => {
      loads += 1;
      return Promise.resolve(create);
    },
  };
}

const recordedAnswer = () => ({ accepted: 1, duplicates: 0, rejected: [], replay });

function start(options: Partial<MiraOptions>, setup?: (fake: ReturnType<typeof fakeHost>) => void) {
  const fake = fakeHost();
  fake.answer = recordedAnswer;
  setup?.(fake);
  const recorder = fakeRecorder();
  const mira = createMira(
    { key: KEY, host: HOST, autocapture: false, ...options },
    fake.host,
    undefined,
    replayControl(recorder.load),
  );
  return { fake, recorder, mira };
}

const withdrawals = (fake: ReturnType<typeof fakeHost>) =>
  fake.requests.filter((request) => request.url.includes("/v1/replay/withdraw"));

describe("below analytics consent", () => {
  test("a recorded answer loads nothing, records nothing and touches no storage", async () => {
    for (const consent of [
      { analytics: false, marketing: false },
      { analytics: "unknown" as const },
    ]) {
      const { fake, recorder, mira } = start({ consent });
      mira.track("viewed_pricing");
      await mira.flush();
      await tick();
      expect(recorder.loads()).toBe(0);
      expect(fake.storageReads()).toBe(0);
      expect(fake.requests.every((request) => !request.url.includes("/v1/replay"))).toBe(true);
    }
  });

  test("a tab's record of a recorded session is not even read", async () => {
    const { fake, recorder } = start({ consent: { analytics: false } }, (host) =>
      host.storage.setItem(REPLAY_KEY, JSON.stringify({ answer: replay, seq: 3, at: Date.now() })),
    );
    await tick();
    expect(recorder.loads()).toBe(0);
    // Set up above; nothing read since.
    expect(fake.storage.accesses).toBe(1);
  });
});

describe("with analytics consent", () => {
  test("the recorder file loads when an answer says the session is recorded, and gets it", async () => {
    const { recorder, mira } = start({ consent: { analytics: true } });
    expect(recorder.loads()).toBe(0);
    mira.track("viewed_pricing");
    await mira.flush();
    await tick();
    expect(recorder.loads()).toBe(1);
    expect(recorder.calls).toEqual(["consent:true", `answer:${SESSION}`]);
  });

  test("an answer without the field loads nothing", async () => {
    const { fake, recorder, mira } = start({ consent: { analytics: true } });
    fake.answer = undefined;
    mira.track("viewed_pricing");
    await mira.flush();
    await tick();
    expect(recorder.loads()).toBe(0);
  });

  test("the tab's record from the previous page loads it at once, before any batch", async () => {
    const { recorder } = start({ consent: { analytics: true } }, (host) =>
      host.storage.setItem(REPLAY_KEY, JSON.stringify({ answer: replay, seq: 3, at: Date.now() })),
    );
    await tick();
    expect(recorder.loads()).toBe(1);
    expect(recorder.calls).toEqual(["consent:true"]);
  });

  test("later answers, page hide and reset go to the loaded recorder", async () => {
    const { fake, recorder, mira } = start({ consent: { analytics: true } });
    mira.track("one");
    await mira.flush();
    await tick();
    mira.reset();
    fake.host.dispatchEvent(new Event("pagehide"));
    mira.track("two");
    await mira.flush();
    expect(recorder.loads()).toBe(1);
    expect(recorder.calls).toEqual([
      "consent:true",
      `answer:${SESSION}`,
      "reset",
      "hide",
      `answer:${SESSION}`,
    ]);
  });

  test("a chunk carries the consent and the ids of the moment", async () => {
    const { recorder, mira } = start({ consent: { analytics: true, marketing: false } });
    mira.identify("user_1");
    mira.track("one");
    await mira.flush();
    await tick();
    const query = recorder.environments[0]!.query();
    expect(query).toMatchObject({
      consent_analytics: "granted",
      consent_marketing: "denied",
      user_id: "user_1",
    });
    expect(typeof query.anonymous_id).toBe("string");
  });
});

describe("consent withdrawn during a visit", () => {
  test("stops the recorder, clears the tab's record and asks the server to delete", async () => {
    const { fake, recorder, mira } = start({ consent: { analytics: true } });
    mira.track("one");
    await mira.flush();
    await tick();
    mira.consent({ analytics: false, marketing: false });
    await tick();
    expect(recorder.calls.at(-1)).toBe("consent:false");
    expect(fake.storage.data.has(REPLAY_KEY)).toBe(false);
    const [withdrawal] = withdrawals(fake);
    expect(withdrawal?.url).toBe(`${HOST}/v1/replay/withdraw?key=${KEY}&session=${SESSION}`);
    expect(withdrawal?.keepalive).toBe(true);
  });

  test("before the recorder has loaded, the tab's record names the session to delete", async () => {
    const fake = fakeHost();
    fake.storage.setItem(REPLAY_KEY, JSON.stringify({ answer: replay, seq: 1, at: Date.now() }));
    const mira = createMira(
      { key: KEY, host: HOST, autocapture: false, consent: { analytics: true } },
      fake.host,
      undefined,
      // A recorder file that never arrives.
      replayControl(() => new Promise(() => {})),
    );
    mira.consent({ analytics: false });
    await tick();
    expect(fake.storage.data.has(REPLAY_KEY)).toBe(false);
    expect(withdrawals(fake)).toHaveLength(1);
  });

  test("a session that a logout ended before the recorder loaded is withdrawn too", async () => {
    const fake = fakeHost();
    fake.answer = recordedAnswer;
    const mira = createMira(
      { key: KEY, host: HOST, autocapture: false, consent: { analytics: true } },
      fake.host,
      undefined,
      replayControl(() => new Promise(() => {})),
    );
    mira.track("one");
    await mira.flush();
    mira.reset();
    mira.consent({ analytics: false });
    await tick();
    expect(withdrawals(fake).map((request) => request.url)).toEqual([
      `${HOST}/v1/replay/withdraw?key=${KEY}&session=${SESSION}`,
    ]);
  });

  test("a 429 or 503 is sent once more, then never again", async () => {
    const { fake, mira } = start({ consent: { analytics: true } });
    mira.track("one");
    await mira.flush();
    await tick();
    const original = setTimeout;
    const waits: number[] = [];
    globalThis.setTimeout = ((handler: () => void, ms: number) => {
      waits.push(ms);
      return original(handler, 0);
    }) as typeof setTimeout;
    try {
      fake.responses.push(503, 429);
      mira.consent({ analytics: false });
      for (let round = 0; round < 5; round += 1) await tick(1);
    } finally {
      globalThis.setTimeout = original;
    }
    expect(withdrawals(fake)).toHaveLength(2);
    expect(waits).toContain(5_000);
  });

  test("no recorded session, no withdrawal", async () => {
    const { fake, mira } = start({ consent: { analytics: true } });
    fake.answer = undefined;
    mira.track("one");
    await mira.flush();
    mira.consent({ analytics: false });
    await tick();
    expect(withdrawals(fake)).toHaveLength(0);
  });

  test("every consent path withdraws: a CMP adapter and Shopify mode", async () => {
    // A CMP through `auto`.
    let emit: (status: ConsentStatus) => void = () => {};
    const cmp: ConsentAdapter = {
      name: "test-cmp",
      detect: () => true,
      subscribe: (_host, next) => {
        emit = next;
        next({ analytics: "granted", marketing: "denied" });
        return () => {};
      },
    };
    const viaCmp = start({ consent: "auto", adapters: [cmp] });
    viaCmp.mira.track("one");
    await viaCmp.mira.flush();
    await tick();
    expect(viaCmp.recorder.loads()).toBe(1);
    emit({ analytics: "denied", marketing: "denied" });
    await tick();
    expect(withdrawals(viaCmp.fake)).toHaveLength(1);

    // Shopify's Customer Privacy API.
    let allowed = true;
    const viaShopify = start({ consent: "shopify" }, (fake) => {
      (fake.host as any).Shopify = {
        customerPrivacy: {
          analyticsProcessingAllowed: () => allowed,
          marketingAllowed: () => false,
          shouldShowBanner: () => false,
        },
      };
    });
    await tick(20);
    viaShopify.mira.track("one");
    await viaShopify.mira.flush();
    await tick();
    expect(viaShopify.recorder.loads()).toBe(1);
    allowed = false;
    viaShopify.fake.host.document.dispatchEvent(new CustomEvent("visitorConsentCollected"));
    await tick();
    expect(withdrawals(viaShopify.fake)).toHaveLength(1);
  });
});

test("pixel mode never records: it passes no recorder", async () => {
  const fake = fakeHost();
  fake.answer = recordedAnswer;
  const mira = createMira(
    { key: KEY, host: HOST, autocapture: false, consent: { analytics: true } },
    fake.host,
  );
  mira.track("one");
  await mira.flush();
  mira.consent({ analytics: false });
  await tick();
  expect(withdrawals(fake)).toHaveLength(0);
});

describe("the transport hands over the answer", () => {
  const send = async (status: number, hook: (body: unknown) => void) => {
    const fake = fakeHost();
    fake.answer = recordedAnswer;
    fake.responses.push(status);
    const transport = new Transport({
      host: HOST,
      key: KEY,
      fetch: fake.host.fetch,
      onAnswer: hook,
    });
    transport.enqueue({
      event_id: "019ac6a4-1c2b-7d3e-8f40-123456789abd",
      type: "track",
      event: "one",
      timestamp: new Date().toISOString(),
    });
    await transport.flush();
    return { fake, transport };
  };

  test("of a 202, with its body", async () => {
    const seen: unknown[] = [];
    await send(202, (body) => seen.push(body));
    expect(seen).toEqual([recordedAnswer()]);
  });

  test("not of any other answer", async () => {
    const seen: unknown[] = [];
    for (const status of [200, 400, 401, 402, 413]) await send(status, (body) => seen.push(body));
    expect(seen).toEqual([]);
  });

  test("a hook that throws never turns a delivered batch into a retry", async () => {
    const { fake, transport } = await send(202, () => {
      throw new Error("broken");
    });
    expect(fake.requests).toHaveLength(1);
    expect(transport.size).toBe(0);
  });
});
