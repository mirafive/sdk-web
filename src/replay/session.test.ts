/* oxlint-disable typescript/no-unsafe-type-assertion -- test fakes stand in for browser globals */
import { describe, expect, test } from "bun:test";

import type { ReplayAnswer } from "@mirafive/protocol";

import { fakeHost } from "../test/fake-host";
import { REPLAY_KEY, type ReplayEnvironment } from "./control";
import {
  readEntry,
  replaySession,
  type RecorderContext,
  type RecorderHandle,
  type StartRecorder,
} from "./session";

const A = "019ac6a4-1c2b-7d3e-8f40-123456789abc";
const B = "019ac6a4-1c2b-7d3e-8f40-cba987654321";
const answerOf = (session_id: string, extra: Partial<ReplayAnswer> = {}): ReplayAnswer => ({
  session_id,
  masking: "standard",
  never_record: [],
  sensitive: [],
  ...extra,
});
const body = (replay?: ReplayAnswer, accepted = 1) => ({
  accepted,
  duplicates: 0,
  rejected: [],
  ...(replay ? { replay } : {}),
});

function setup(options: { fake?: ReturnType<typeof fakeHost>; unavailable?: boolean } = {}) {
  const fake = options.fake ?? fakeHost();
  const started: RecorderContext[] = [];
  const log: string[] = [];
  const start: StartRecorder = (context) => {
    started.push(context);
    if (options.unavailable) return undefined;
    const name = `${context.answer.session_id.slice(-4)}#${started.length}`;
    const handle: RecorderHandle = {
      update: (answer) => log.push(`${name} update ${answer.masking}`),
      cut: () => log.push(`${name} cut`),
      hide: () => log.push(`${name} hide`),
      stop: (keep) => log.push(`${name} stop ${keep ? "keep" : "drop"}`),
    };
    return handle;
  };
  const environment = {
    host: fake.host,
    ingest: "https://ingest.example",
    key: "mira_pk_test",
    fetch: fake.host.fetch,
    query: () => ({ consent_analytics: "granted", consent_marketing: "denied" }),
    warn: () => {},
  } satisfies ReplayEnvironment;
  const session = replaySession(environment, start);
  const stored = () => readEntry(fake.storage.getItem(REPLAY_KEY), Date.now());
  return { fake, session, started, log, stored };
}

describe("the server's decision", () => {
  test("a recorded answer starts the recorder with the session and chunk 0", () => {
    const { session, started, stored } = setup();
    session.consent(true);
    session.answer(body(answerOf(A)));
    expect(started).toHaveLength(1);
    expect(started[0]!.answer.session_id).toBe(A);
    expect(started[0]!.nextSeq()).toBe(0);
    expect(stored()?.answer.session_id).toBe(A);
  });

  test("the same session again updates the settings of the running recorder", () => {
    const { session, started, log } = setup();
    session.consent(true);
    session.answer(body(answerOf(A)));
    session.answer(body(answerOf(A, { masking: "strict" })));
    expect(started).toHaveLength(1);
    expect(log).toEqual(["9abc#1 update strict"]);
  });

  test("another session: the old one sends what it has, the new one starts at chunk 0", () => {
    const { session, started, log, stored } = setup();
    session.consent(true);
    session.answer(body(answerOf(A)));
    started[0]!.nextSeq();
    session.answer(body(answerOf(B)));
    expect(log).toEqual(["9abc#1 stop keep"]);
    expect(started[1]!.answer.session_id).toBe(B);
    expect(started[1]!.nextSeq()).toBe(0);
    expect(stored()?.answer.session_id).toBe(B);
    // The old recorder's numbers no longer touch the tab's record.
    started[0]!.nextSeq();
    expect(stored()?.seq).toBe(1);
  });

  test("an accepted batch without the field stops recording and clears the tab's record", () => {
    const { session, log, stored } = setup();
    session.consent(true);
    session.answer(body(answerOf(A)));
    session.answer(body());
    expect(log).toEqual(["9abc#1 stop keep"]);
    expect(stored()).toBeUndefined();
  });

  test("an answer that accepted nothing (a retry the server had seen) changes nothing", () => {
    const { session, log, stored } = setup();
    session.consent(true);
    session.answer(body(answerOf(A)));
    session.answer(body(undefined, 0));
    session.answer(body(answerOf(B), 0));
    session.answer(undefined);
    session.answer("not json");
    expect(log).toEqual([]);
    expect(stored()?.answer.session_id).toBe(A);
  });

  test("a malformed field is no decision", () => {
    const { session, started } = setup();
    session.consent(true);
    session.answer({ accepted: 1, replay: { session_id: "x", masking: "loose" } });
    expect(started).toHaveLength(0);
  });

  test("without analytics consent an answer is ignored", () => {
    const { session, started, fake } = setup();
    session.answer(body(answerOf(A)));
    expect(started).toHaveLength(0);
    expect(fake.storageReads()).toBe(0);
  });
});

describe("the next page of the tab", () => {
  test("records from its first moment and goes on with the chunk numbers", () => {
    const first = setup();
    first.session.consent(true);
    first.session.answer(body(answerOf(A)));
    expect([first.started[0]!.nextSeq(), first.started[0]!.nextSeq()]).toEqual([0, 1]);

    // A new document of the same tab: the same sessionStorage, a new instance.
    const next = setup({ fake: first.fake });
    next.session.consent(true);
    expect(next.started).toHaveLength(1);
    expect(next.started[0]!.answer.session_id).toBe(A);
    expect(next.started[0]!.nextSeq()).toBe(2);
  });

  test("a record older than a decision lives, or a malformed one, is ignored", () => {
    const now = Date.now();
    const answer = answerOf(A);
    expect(readEntry(JSON.stringify({ answer, seq: 4, at: now - 1000 }), now)?.seq).toBe(4);
    for (const raw of [
      JSON.stringify({ answer, seq: 4, at: now - 25 * 60 * 60 * 1000 }),
      JSON.stringify({ answer, seq: -1, at: now }),
      JSON.stringify({ answer, seq: 1.5, at: now }),
      JSON.stringify({ answer: { ...answer, masking: "none" }, seq: 1, at: now }),
      JSON.stringify({ answer, seq: 1 }),
      "{",
      "null",
      null,
    ]) {
      expect(readEntry(raw, now)).toBeUndefined();
    }
  });
});

describe("refusals", () => {
  test("a 409 stops the session: the record goes, its later answers start nothing", () => {
    const { session, started, stored } = setup();
    session.consent(true);
    session.answer(body(answerOf(A)));
    started[0]!.stopped("session");
    expect(stored()).toBeUndefined();
    session.answer(body(answerOf(A)));
    expect(started).toHaveLength(1);
    // A new session the server chose starts again.
    session.answer(body(answerOf(B)));
    expect(started).toHaveLength(2);
  });

  test("a refusal for the page keeps the record for the next page, but starts nothing here", () => {
    const { session, started, stored } = setup();
    session.consent(true);
    session.answer(body(answerOf(A)));
    started[0]!.stopped("page");
    session.answer(body(answerOf(A)));
    session.answer(body(answerOf(B)));
    expect(started).toHaveLength(1);
    expect(stored()?.answer.session_id).toBe(B);
  });

  test("a browser that cannot record is not asked again", () => {
    const { session, started } = setup({ unavailable: true });
    session.consent(true);
    session.answer(body(answerOf(A)));
    session.answer(body(answerOf(A)));
    expect(started).toHaveLength(1);
  });
});

describe("consent", () => {
  test("withdrawn: the recorder drops its buffer and the tab's record goes", () => {
    const { session, log, stored } = setup();
    session.consent(true);
    session.answer(body(answerOf(A)));
    expect(session.sessions).toEqual([A]);
    session.consent(false);
    expect(log).toEqual(["9abc#1 stop drop"]);
    expect(stored()).toBeUndefined();
  });

  test("withdrawn: a recorder still sending for an earlier session drops it too, and both are named", () => {
    const { session, log } = setup();
    session.consent(true);
    session.answer(body(answerOf(A)));
    session.answer(body(answerOf(B)));
    session.consent(false);
    expect(log).toEqual(["9abc#1 stop keep", "4321#2 stop drop", "9abc#1 stop drop"]);
    expect(session.sessions).toEqual([A, B]);
  });

  test("page hide reaches the recorder", () => {
    const { session, log } = setup();
    session.consent(true);
    session.answer(body(answerOf(A)));
    session.hide();
    expect(log).toEqual(["9abc#1 hide"]);
  });
});

describe("reset (logout)", () => {
  test("what was recorded leaves, the session ends, the tab's record goes", () => {
    const { session, log, started, stored } = setup();
    session.consent(true);
    session.answer(body(answerOf(A)));
    session.reset();
    expect(log).toEqual(["9abc#1 stop keep"]);
    expect(stored()).toBeUndefined();
    // The old session never starts again on this page; a new decision does.
    session.answer(body(answerOf(A)));
    expect(started).toHaveLength(1);
    session.answer(body(answerOf(B)));
    expect(started).toHaveLength(2);
  });
});

describe("numbering", () => {
  test("a session that is stopped and named again goes on with its numbers", () => {
    const { session, started } = setup();
    session.consent(true);
    session.answer(body(answerOf(A)));
    expect([started[0]!.nextSeq(), started[0]!.nextSeq()]).toEqual([0, 1]);
    session.answer(body());
    session.answer(body(answerOf(A)));
    expect(started[1]!.nextSeq()).toBe(2);
  });
});

describe("a page nobody sees yet", () => {
  test("prerendered: the recorder starts when the page is shown", () => {
    const fake = fakeHost();
    const document = fake.host.document as unknown as { prerendering: boolean };
    document.prerendering = true;
    const { session, started } = setup({ fake });
    session.consent(true);
    session.answer(body(answerOf(A)));
    expect(started).toHaveLength(0);
    document.prerendering = false;
    fake.host.document.dispatchEvent(new Event("prerenderingchange"));
    expect(started).toHaveLength(1);
  });

  test("hidden since it opened (a background tab): the recorder starts when it is shown", () => {
    const fake = fakeHost();
    const document = fake.host.document as unknown as { visibilityState: string };
    document.visibilityState = "hidden";
    const { session, started } = setup({ fake });
    session.consent(true);
    session.answer(body(answerOf(A)));
    session.answer(body(answerOf(A)));
    expect(started).toHaveLength(0);
    document.visibilityState = "visible";
    fake.host.document.dispatchEvent(new Event("visibilitychange"));
    expect(started).toHaveLength(1);
  });

  test("consent withdrawn while waiting: it never starts", () => {
    const fake = fakeHost();
    const document = fake.host.document as unknown as { visibilityState: string };
    document.visibilityState = "hidden";
    const { session, started } = setup({ fake });
    session.consent(true);
    session.answer(body(answerOf(A)));
    session.consent(false);
    document.visibilityState = "visible";
    fake.host.document.dispatchEvent(new Event("visibilitychange"));
    expect(started).toHaveLength(0);
  });
});
