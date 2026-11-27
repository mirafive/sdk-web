import { describe, expect, test } from "bun:test";

import { cleanAttribute, sanitize, type RecordedEvent } from "./sanitize";

const none = () => undefined;
const element = (
  tagName: string,
  attributes: Record<string, unknown>,
  childNodes: unknown[] = [],
  id = 1,
) => ({
  type: 2,
  tagName,
  attributes,
  childNodes,
  id,
});

describe("attributes", () => {
  test("text a person may have put there passes the PII guard", () => {
    for (const name of [
      "title",
      "alt",
      "placeholder",
      "value",
      "aria-label",
      "data-customer",
      "label",
    ]) {
      const cleaned = cleanAttribute(name, "Contact jana@example.com or +49 30 1234567") as string;
      expect(cleaned).not.toContain("jana@example.com");
      expect(cleaned).not.toContain("1234567");
    }
    expect(cleanAttribute("title", "IBAN DE89 3704 0044 0532 0130 00")).not.toContain("3704");
    expect(cleanAttribute("data-card", "4111111111111111")).toBe("****************");
  });

  test("a mail or phone link keeps only its scheme", () => {
    expect(cleanAttribute("href", "mailto:jana@example.com?subject=Hi")).toBe("mailto:");
    expect(cleanAttribute("href", "tel:+49301234567")).toBe("tel:");
    expect(cleanAttribute("href", "/orders?email=jana@example.com")).toBe(
      "/orders?email=****************",
    );
    expect(cleanAttribute("href", "/products/shirt")).toBe("/products/shirt");
  });

  test("other attributes and values that are not text stay as they are", () => {
    expect(cleanAttribute("class", "jana@example.com")).toBe("jana@example.com");
    expect(cleanAttribute("title", null)).toBe(null);
    expect(cleanAttribute("style", { color: "red" })).toEqual({ color: "red" });
  });
});

describe("web addresses", () => {
  test("a link or a form's action loses its query and fragment, which can carry tokens", () => {
    expect(cleanAttribute("href", "https://shop.example/reset?token=abc123#x")).toBe(
      "https://shop.example/reset",
    );
    expect(cleanAttribute("action", "https://shop.example/login?next=/account")).toBe(
      "https://shop.example/login",
    );
    expect(cleanAttribute("href", "#reviews")).toBe("#reviews");
  });

  test("so does the page's address in a meta event", () => {
    const event: RecordedEvent = {
      type: 4,
      timestamp: 1,
      data: { href: "https://shop.example/account/reset?token=abc123", width: 1, height: 1 },
    };
    expect(sanitize(event, none).data.href).toBe("https://shop.example/account/reset");
  });
});

describe("events", () => {
  test("the full snapshot, all the way down", () => {
    const deep = element("span", { title: "jana@example.com" }, [], 3);
    const event: RecordedEvent = {
      type: 2,
      timestamp: 1,
      data: {
        node: { type: 0, childNodes: [element("div", { "data-x": "+49 30 1234567" }, [deep], 2)] },
      },
    };
    const text = JSON.stringify(sanitize(event, none));
    expect(text).not.toContain("jana@example.com");
    expect(text).not.toContain("1234567");
  });

  test("added nodes and attribute changes", () => {
    const event: RecordedEvent = {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        adds: [
          { parentId: 1, nextId: null, node: element("a", { href: "mailto:jana@example.com" }) },
        ],
        attributes: [
          { id: 4, attributes: { "aria-label": "Call 030 1234567", style: { color: "red" } } },
        ],
        texts: [],
        removes: [],
      },
    };
    const text = JSON.stringify(sanitize(event, none));
    expect(text).not.toContain("jana@example.com");
    expect(text).not.toContain("1234567");
    expect(text).toContain('"color":"red"');
  });

  test("the page URL of a meta event", () => {
    const event: RecordedEvent = {
      type: 4,
      timestamp: 1,
      data: { href: "https://shop.example/thanks?email=jana@example.com", width: 1, height: 1 },
    };
    expect(sanitize(event, none).data.href).not.toContain("jana@example.com");
  });

  test("other events are left alone", () => {
    const event: RecordedEvent = { type: 3, timestamp: 1, data: { source: 1, positions: [] } };
    expect(sanitize(event, none)).toEqual({
      type: 3,
      timestamp: 1,
      data: { source: 1, positions: [] },
    });
  });
});

describe("stylesheets from browser extensions", () => {
  test("are dropped when their text names an extension", () => {
    const event: RecordedEvent = {
      type: 2,
      timestamp: 1,
      data: {
        node: element("style", {
          _cssText: ".x { background: url(chrome-extension://abc/i.png) }",
        }),
      },
    };
    expect(sanitize(event, none).data.node.attributes._cssText).toBe("");
  });

  test("and when the live sheet, or one it imports, comes from an extension", () => {
    const imported = { href: "moz-extension://abc/style.css", cssRules: [] };
    const sheet = {
      href: null,
      cssRules: [{ styleSheet: imported, href: "moz-extension://abc/style.css" }],
    };
    const event: RecordedEvent = {
      type: 2,
      timestamp: 1,
      data: { node: element("style", { _cssText: ".x { color: red }" }, [], 7) },
    };
    const nodeOf = (id: number) => (id === 7 ? { sheet } : undefined);
    expect(sanitize(event, nodeOf).data.node.attributes._cssText).toBe("");
  });

  test("the site's own stylesheets stay", () => {
    const sheet = { href: "https://shop.example/theme.css", cssRules: [{ selectorText: ".x" }] };
    const event: RecordedEvent = {
      type: 2,
      timestamp: 1,
      data: { node: element("link", { _cssText: ".x { color: red }" }, [], 7) },
    };
    expect(sanitize(event, () => ({ sheet })).data.node.attributes._cssText).toBe(
      ".x { color: red }",
    );
  });
});
