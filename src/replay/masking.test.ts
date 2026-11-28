import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { ReplayAnswer } from "@mirafive/protocol";

import {
  BLOCK_SELECTOR,
  INPUT_MASK,
  maskInput,
  maskText,
  masksAllText,
  neverRecorded,
  recordOptions,
  type Masking,
} from "./masking";

const answer = (extra: Partial<ReplayAnswer> = {}): ReplayAnswer => ({
  session_id: "019ac6a4-1c2b-7d3e-8f40-123456789abc",
  masking: "standard",
  never_record: ["/account/*", "/checkout/payment"],
  sensitive: ["/checkout*"],
  ...extra,
});
const on = (path: string, extra: Partial<ReplayAnswer> = {}): Masking => ({
  answer: answer(extra),
  path: () => path,
});
/** An element as rrweb passes it to the text hook: its tag and what `closest` finds. */
const element = (tagName: string, inside: string[] = []) => ({
  tagName,
  closest: (selector: string) => (inside.includes(selector) ? {} : null),
});

describe("rrweb's defaults the recorder relies on or overrides", () => {
  // A release of rrweb that changes any of these fails here, before it can record more than it
  // should. Read from the code that runs: the destructured options of `record`.
  const source = readFileSync(
    new URL("../../node_modules/@rrweb/record/dist/record.js", import.meta.url),
    "utf8",
  );

  test("the version is the one these defaults were read from", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../node_modules/@rrweb/record/package.json", import.meta.url),
        "utf8",
      ),
    );
    expect(manifest.version).toBe("2.2.2");
  });

  test("record's options and their defaults", () => {
    const line = /function record\(options = \{\}\) \{\s*const \{ (emit,.*?) \} = options;/s.exec(
      source,
    )?.[1];
    expect(
      line
        ?.split(", ")
        .map((part) => part.trim())
        .filter((part) => part.includes("=")),
    ).toEqual([
      'blockClass = "rr-block"',
      "blockSelector = null",
      'ignoreClass = "rr-ignore"',
      "ignoreSelector = null",
      'maskTextClass = "rr-mask"',
      "maskTextSelector = null",
      "inlineStylesheet = true",
      "sampling = {}",
      "dataURLOptions = {}",
      "recordDOM = true",
      "recordCanvas = false",
      "recordCrossOriginIframes = false",
      'recordAfter = options.recordAfter === "DOMContentLoaded" ? options.recordAfter : "load"',
      "userTriggeredOnInput = false",
      "collectFonts = false",
      "inlineImages = false",
      "keepIframeSrcFn = () => false",
      "ignoreCSSAttributes = /* @__PURE__ */ new Set([])",
    ]);
    // No default for these: no periodic full snapshot, all inputs only when asked.
    for (const name of [
      "checkoutEveryNms",
      "checkoutEveryNth",
      "maskAllInputs",
      "maskInputFn",
      "maskTextFn",
    ]) {
      expect(line).toContain(` ${name},`);
    }
  });

  test("without maskInputOptions only passwords are masked, and maskAllInputs forgets hidden", () => {
    expect(source).toContain(
      ": _maskInputOptions !== void 0 ? _maskInputOptions : { password: true };",
    );
    const all = /maskAllInputs === true \? \{([^}]*)\}/.exec(source)?.[1] ?? "";
    expect(all).toContain("password: true");
    expect(all).not.toContain("hidden");
  });

  test("a masked value is asterisks of its length unless maskInputFn says otherwise", () => {
    expect(source).toContain(
      'if (maskInputFn) text = maskInputFn(text, element);\n\t\telse text = "*".repeat(text.length);',
    );
  });

  test("pointer movement every 50 ms, no slimming, scripts kept as a placeholder", () => {
    expect(source).toContain('typeof sampling.mousemove === "number" ? sampling.mousemove : 50');
    expect(source).toMatch(/else if \(_slimDOMOptions\) return _slimDOMOptions;\s*return \{\};/);
    expect(source).toContain('if (isScript) textContent = "SCRIPT_PLACEHOLDER";');
  });

  test("a blocked element keeps only its class and size", () => {
    expect(source).toContain(
      "if (needBlock) {\n\t\tconst { width, height } = n.getBoundingClientRect();\n\t\tattributes = {\n\t\t\tclass: attributes.class,\n\t\t\trr_width: `${width}px`,\n\t\t\trr_height: `${height}px`\n\t\t};",
    );
  });
});

describe("the options the recorder sets", () => {
  test("every one that decides what is recorded", () => {
    const { maskTextFn, maskInputFn, keepIframeSrcFn, ...options } = recordOptions(on("/"));
    expect(options).toEqual({
      blockClass: "rr-block",
      blockSelector: BLOCK_SELECTOR,
      ignoreClass: "rr-ignore",
      ignoreSelector: "[data-mira-ignore]",
      maskTextClass: "rr-mask",
      maskTextSelector: "*",
      maskAllInputs: false,
      maskInputOptions: {
        color: true,
        date: true,
        "datetime-local": true,
        email: true,
        hidden: true,
        month: true,
        number: true,
        password: true,
        range: true,
        search: true,
        tel: true,
        text: true,
        time: true,
        url: true,
        week: true,
        textarea: true,
        select: true,
      },
      inlineStylesheet: true,
      inlineImages: false,
      recordCanvas: false,
      collectFonts: false,
      recordCrossOriginIframes: false,
      slimDOMOptions: {},
      sampling: { mousemove: 50 },
      userTriggeredOnInput: false,
      checkoutEveryNms: undefined,
      checkoutEveryNth: undefined,
      recordAfter: "DOMContentLoaded",
    });
    expect(keepIframeSrcFn()).toBe(false);
    expect(maskInputFn).toBe(maskInput);
    expect(typeof maskTextFn).toBe("function");
  });

  test("passwords, payment fields and one-time codes are blocked, not masked", () => {
    for (const selector of [
      "[data-mira-block]",
      "input[type=password]",
      '[autocomplete^="cc-"]',
      '[autocomplete="one-time-code"]',
      '[autocomplete="current-password"]',
      '[autocomplete="new-password"]',
      'link[href^="chrome-extension:"]',
      'link[href^="moz-extension:"]',
      'link[href^="safari-web-extension:"]',
    ]) {
      expect(BLOCK_SELECTOR.split(",")).toContain(selector);
    }
  });

  test("no setting of the server can unblock them: the answer does not reach the selector", () => {
    for (const masking of ["standard", "strict"] as const) {
      expect(
        recordOptions(on("/", { masking, sensitive: [], never_record: [] })).blockSelector,
      ).toBe(BLOCK_SELECTOR);
    }
  });

  test("a masked input shows a fixed mask, whatever its length; an empty one stays empty", () => {
    expect(maskInput("4111 1111 1111 1111")).toBe(INPUT_MASK);
    expect(maskInput("a")).toBe(INPUT_MASK);
    expect(maskInput("")).toBe("");
  });
});

describe("text", () => {
  test("plain text passes the PII guard", () => {
    const text = "Mail jana@example.com, IBAN DE89 3704 0044 0532 0130 00, call +49 30 1234567";
    const masked = maskText(on("/"), text, element("P"));
    expect(masked).not.toContain("jana@example.com");
    expect(masked).not.toContain("DE89 3704");
    expect(masked).not.toContain("1234567");
    expect(masked.startsWith("Mail ")).toBe(true);
    expect(maskText(on("/"), "Card 4111 1111 1111 1111 ok", element("SPAN"))).toBe(
      "Card ******************* ok",
    );
  });

  test("inside data-mira-mask it keeps its shape, never its characters", () => {
    expect(maskText(on("/"), "Jana Doe", element("SPAN", ["[data-mira-mask]"]))).toBe("**** ***");
  });

  test("a textarea's text is its value: masked like an input", () => {
    expect(maskText(on("/"), "my secret note", element("TEXTAREA"))).toBe(INPUT_MASK);
  });

  test("everything is masked in strict mode and on sensitive pages, looked up on every text", () => {
    expect(maskText(on("/", { masking: "strict" }), "Hello", element("P"))).toBe("*****");
    let path = "/";
    const masking: Masking = { answer: answer(), path: () => path };
    expect(maskText(masking, "Hello", element("P"))).toBe("Hello");
    // A single-page navigation to a sensitive page: the next text is masked.
    path = "/checkout/shipping";
    expect(maskText(masking, "Hello", element("P"))).toBe("*****");
  });

  test("whitespace stays as it is", () => {
    expect(maskText(on("/", { masking: "strict" }), "  \n ", element("P"))).toBe("  \n ");
  });
});

describe("page patterns", () => {
  test("never recorded and sensitive pages, as matchesPage reads them", () => {
    expect(neverRecorded(answer(), "/account/orders/7")).toBe(true);
    expect(neverRecorded(answer(), "/account")).toBe(false);
    expect(neverRecorded(answer(), "/checkout/payment")).toBe(true);
    expect(neverRecorded(answer(), "/checkout/payment/")).toBe(false);
    expect(masksAllText(answer(), "/checkout")).toBe(true);
    expect(masksAllText(answer(), "/cart")).toBe(false);
    expect(masksAllText(answer({ masking: "strict" }), "/cart")).toBe(true);
  });
});
