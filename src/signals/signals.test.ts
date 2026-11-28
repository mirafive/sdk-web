import { describe, expect, test } from "bun:test";

import { SIGNAL_RULES } from "@mirafive/protocol";

import { answeredClicks, continuesBurst, isRage, leavesByLink, type Click } from "./clicks";
import { signalsControl, type Signals } from "./control";
import { clickableOf, fieldOf, isStable, labelOf, selectorOf, type ElementLike } from "./element";
import { exceptionOf, ownSite, rejectionOf, requestOf } from "./problems";
import { clsOf, inpOf } from "./vitals";

const rage = SIGNAL_RULES.rage;
const click = (at: number, reactions = 0, fields = "", x = 100, y = 100): Click => ({
  x,
  y,
  at,
  reactions,
  fields,
});

describe("rage clicks", () => {
  test("five fast clicks on a button that never answers are one rage click", () => {
    const clicks = [0, 150, 300, 450, 600].map((at) => click(at));
    expect(isRage(clicks, 0, "", rage)).toBe(true);
  });

  test("a double or triple click is too short to be rage", () => {
    expect(isRage([click(0), click(120)], 0, "", rage)).toBe(false);
    expect(isRage([click(0), click(120), click(240)], 0, "", rage)).toBe(false);
  });

  test("a carousel's next button moves on every click: answered, no rage", () => {
    const clicks = [0, 1, 2, 3, 4].map((index) => click(index * 200, index));
    expect(answeredClicks(clicks, 5, "")).toBe(5);
    expect(isRage(clicks, 5, "", rage)).toBe(false);
  });

  test("a quantity stepper changes its field on every click: answered, no rage", () => {
    const clicks = [1, 2, 3, 4, 5].map((quantity, index) => click(index * 150, 0, `${quantity}`));
    expect(isRage(clicks, 0, "6", rage)).toBe(false);
  });

  test("a slow button that answers the first click only is still rage", () => {
    const clicks = [click(0, 0), click(200, 1), click(400, 1), click(600, 1)];
    expect(answeredClicks(clicks, 1, "")).toBe(1);
    expect(isRage(clicks, 1, "", rage)).toBe(true);
  });

  test("a burst ends with a pause or a move away", () => {
    const first = click(0);
    expect(continuesBurst(first, first, { x: 110, y: 105, at: 300 }, rage)).toBe(true);
    expect(continuesBurst(first, first, { x: 100, y: 100, at: 700 }, rage)).toBe(false);
    expect(continuesBurst(first, first, { x: 200, y: 100, at: 100 }, rage)).toBe(false);
  });
});

describe("links that leave the page are never dead", () => {
  const page = "https://shop.example/cart";
  test("a link to another page, a new tab, a download", () => {
    expect(leavesByLink("/checkout", page, false)).toBe(true);
    expect(leavesByLink("https://other.example/", page, false)).toBe(true);
  });
  test("unless the page prevented it, or it goes nowhere", () => {
    expect(leavesByLink("/checkout", page, true)).toBe(false);
    expect(leavesByLink("#", page, false)).toBe(false);
    expect(leavesByLink("javascript:void(0)", page, false)).toBe(false);
    expect(leavesByLink(null, page, false)).toBe(false);
  });
});

/** A tiny element for the element rules. */
function el(
  tagName: string,
  attributes: Record<string, string> = {},
  options: {
    classes?: string[];
    text?: string;
    parent?: ElementLike | null;
    matches?: string[];
  } = {},
): ElementLike {
  const self: ElementLike = {
    tagName: tagName.toUpperCase(),
    id: attributes.id ?? "",
    classList: options.classes ?? [],
    parentElement: options.parent ?? null,
    getAttribute: (name) => attributes[name] ?? null,
    matches: (selector) =>
      selector.split(",").some((part) => (options.matches ?? []).includes(part.trim())),
    closest: (selector) => {
      for (let node: ElementLike | null = self; node; node = node.parentElement) {
        if (node.matches(selector)) return node;
      }
      return null;
    },
    textContent: options.text ?? "",
  };
  return self;
}

describe("what a signal says about an element", () => {
  test("a short selector stops at a stable id and leaves out generated names", () => {
    const form = el("form", { id: "checkout" });
    const row = el("div", {}, { classes: ["css-1x2y3z", "row"], parent: form });
    const button = el("button", {}, { classes: ["apply", "sc-a1b2c3"], parent: row });
    expect(selectorOf(button)).toBe("form#checkout > div.row > button.apply");
    expect(isStable("btn-1234567")).toBe(false);
  });

  test("the label is the visible text, blanked where it holds an email", () => {
    const button = el("button", {}, { text: "  Notify   jana@example.com " });
    expect(labelOf(button)).toBe("Notify [redacted:email]");
  });

  test("a masked element has no label, and a text field's value is never one", () => {
    const masked = el("button", {}, { text: "Secret", matches: ["[data-mira-mask]"] });
    expect(labelOf(masked)).toBe("");
    const field = el("input", { value: "jana" }, { matches: ["input"] });
    expect(labelOf(field)).toBe("");
  });

  test("a field is named by its name, else by its label, never by its value", () => {
    expect(fieldOf(el("input", { name: "email", value: "x@y.z" }), () => null)).toEqual({
      name: "email",
      label: false,
    });
    expect(
      fieldOf(el("input", { id: "f1" }), () => el("label", {}, { text: "Your street" })),
    ).toEqual({ name: "Your street", label: true });
  });

  test("a field the page masks is never named by its label", () => {
    const masked = el("input", { id: "" }, { matches: ["[data-mira-mask]"] });
    expect(fieldOf(masked, () => el("label", {}, { text: "Diagnosis" }))).toEqual({
      name: "",
      label: false,
    });
  });

  test("a disabled control does not look clickable", () => {
    const disabled = el("button", {}, { matches: ["button", ":disabled"] });
    expect(clickableOf(disabled, () => "pointer")).toBeUndefined();
    const plain = el("div");
    expect(clickableOf(plain, () => "auto")).toBeUndefined();
    expect(clickableOf(plain, () => "pointer")).toBe(plain);
  });
});

describe("errors that are the site's to fix", () => {
  const page = "https://shop.example/cart";
  test("an exception with its source, origin and path only", () => {
    const problem = exceptionOf(
      new TypeError("x is undefined"),
      "",
      "https://shop.example/app.js?v=9",
      10,
      4,
      page,
    );
    expect(problem).toEqual({
      kind: "exception",
      message: "TypeError: x is undefined",
      source: "https://shop.example/app.js:10:4",
    });
  });

  test("a browser extension's error, Script error. and the ResizeObserver loop are no signal", () => {
    expect(
      exceptionOf(undefined, "boom", "chrome-extension://abc/content.js", 1, 1, page),
    ).toBeUndefined();
    expect(exceptionOf(undefined, "Script error.", "", 0, 0, page)).toBeUndefined();
    expect(
      exceptionOf(
        undefined,
        "ResizeObserver loop completed with undelivered notifications.",
        "",
        0,
        0,
        page,
      ),
    ).toBeUndefined();
  });

  test("an aborted request's rejection is no error", () => {
    expect(
      rejectionOf(new DOMException("The user aborted a request.", "AbortError")),
    ).toBeUndefined();
    expect(rejectionOf(new Error("Failed to load cart"))?.message).toBe(
      "Error: Failed to load cart",
    );
  });

  test("only the site's own requests with an HTTP error count, without their query", () => {
    expect(requestOf("post", "https://api.shop.example/cart?token=abc", 500, page)).toEqual({
      kind: "request",
      message: "POST /cart 500",
      url: "https://api.shop.example/cart",
      method: "POST",
      status: 500,
    });
    expect(requestOf("GET", "https://ads.example/pixel", 500, page)).toBeUndefined();
    expect(requestOf("GET", "/cart", 200, page)).toBeUndefined();
    expect(ownSite("https://www.shop.example/x", "https://shop.example/")).toBe(true);
  });
});

describe("web vitals", () => {
  test("INP leaves out one interaction in every 50", () => {
    expect(inpOf([120, 900, 300], 3)).toBe(900);
    expect(inpOf([120, 900, 300], 60)).toBe(300);
    expect(inpOf([120, 900, 300], 120)).toBe(120);
    expect(inpOf([], 10)).toBeUndefined();
  });

  test("CLS is the largest session window", () => {
    expect(
      clsOf([
        [0, 0.1],
        [500, 0.1],
        [3_000, 0.05],
      ]),
    ).toBeCloseTo(0.2);
    expect(
      clsOf([
        [0, 0.1],
        [800, 0.1],
        [1_600, 0.1],
        [2_400, 0.1],
        [3_200, 0.1],
        [5_200, 0.1],
      ]),
    ).toBeCloseTo(0.5);
  });
});

describe("the loader in the base script", () => {
  test("loads the detector only for an answer with signals, once, and hands it every answer", async () => {
    let loads = 0;
    const seen: unknown[] = [];
    const detector: Signals = { answer: (body) => seen.push(body), hide: () => {} };
    const control = signalsControl(async () => {
      loads += 1;
      return () => detector;
    })({ host: {} as never, analytics: () => false, track: () => {} });
    control.answer({ accepted: 1 });
    expect(loads).toBe(0);
    control.answer({ accepted: 1, signals: { consent: "none" } });
    control.answer({ accepted: 1, signals: { consent: "none" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toBe(1);
    control.answer({ accepted: 2 });
    expect(seen).toHaveLength(2);
  });
});
