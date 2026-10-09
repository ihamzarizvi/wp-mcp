import { describe, expect, it } from "vitest";
import * as bricks from "../src/bricks.js";

// section > container > (heading, text), then a second root section.
const page = () =>
  bricks.normalise([
    { id: "secaaa", name: "section", parent: 0, children: ["conaaa"], settings: [], label: "Hero" },
    { id: "conaaa", name: "container", parent: "secaaa", children: ["headaa", "textaa"], settings: { _cssGlobalClasses: ["cls001"] } },
    { id: "headaa", name: "heading", parent: "conaaa", children: [], settings: { text: "<b>Junk</b> removal", tag: "h1" } },
    { id: "textaa", name: "text-basic", parent: "conaaa", children: [], settings: { text: "x".repeat(200) } },
    { id: "secbbb", name: "section", parent: "0", settings: { _cssClasses: "cta dark" } },
  ]);

const rootIds = (els: bricks.BricksElement[]) => els.filter((e) => !e.parent).map((e) => e.id);
const get = (els: bricks.BricksElement[], id: string) => els.find((e) => e.id === id)!;

describe("normalise and validate", () => {
  it("repairs the shapes PHP returns", () => {
    const els = page();
    expect(get(els, "secaaa").settings).toEqual({});
    expect(get(els, "secbbb")).toMatchObject({ parent: 0, children: [], settings: { _cssClasses: "cta dark" } });
    expect(() => bricks.validate(els)).not.toThrow();
  });
  it("rejects duplicate ids and broken links", () => {
    const dup = [...page(), ...page().slice(4)];
    expect(() => bricks.validate(dup)).toThrow(/Duplicate/);
    const orphan = page();
    get(orphan, "headaa").parent = "nope";
    expect(() => bricks.validate(orphan)).toThrow(/different parent|does not exist/);
    const unlisted = page();
    get(unlisted, "conaaa").children = ["headaa"];
    expect(() => bricks.validate(unlisted)).toThrow(/missing from the children/);
    const stolen = page();
    get(stolen, "secbbb").children = ["headaa"];
    expect(() => bricks.validate(stolen)).toThrow(/different parent/);
  });
});

describe("outline", () => {
  it("nests elements and summarises text and classes", () => {
    const out = bricks.outline(page(), { cls001: "hero-wrap" });
    expect(out.map((n) => n.id)).toEqual(["secaaa", "secbbb"]);
    expect(out[0]).toMatchObject({ name: "section", label: "Hero" });
    const container = out[0].children![0];
    expect(container.classes).toEqual(["hero-wrap"]);
    expect(container.children![0]).toMatchObject({ id: "headaa", text: "Junk removal" });
    expect(container.children![1].text!.length).toBeLessThanOrEqual(81);
    expect(out[1].classes).toEqual(["cta", "dark"]);
    expect(JSON.stringify(out)).not.toContain("settings");
  });
  it("can start at one element and reports unknown ids", () => {
    expect(bricks.outline(page(), {}, "conaaa")[0].children).toHaveLength(2);
    expect(() => bricks.outline(page(), {}, "zzzzzz")).toThrow(/No element/);
  });
});

describe("addElements", () => {
  const spec = [{ name: "container", label: "New", children: [{ name: "heading", settings: { text: "Hi" } }, { name: "button", settings: { text: "Go" } }] }];
  it("adds a nested block inside a parent at a position", () => {
    const { elements, addedIds, topIds } = bricks.addElements(page(), spec, "secaaa", 0);
    expect(addedIds).toHaveLength(3);
    expect(new Set([...addedIds, "secaaa", "conaaa", "headaa", "textaa", "secbbb"]).size).toBe(8);
    expect(addedIds.every((id) => /^[a-z]{6}$/.test(id))).toBe(true);
    expect(get(elements, "secaaa").children).toEqual([topIds[0], "conaaa"]);
    expect(get(elements, topIds[0])).toMatchObject({ parent: "secaaa", label: "New" });
    expect(get(elements, topIds[0]).children).toHaveLength(2);
    expect(() => bricks.validate(elements)).not.toThrow();
  });
  it("adds at the top level, last by default or before a given root", () => {
    const last = bricks.addElements(page(), [{ name: "section" }]);
    expect(rootIds(last.elements)).toEqual(["secaaa", "secbbb", last.topIds[0]]);
    const middle = bricks.addElements(page(), [{ name: "section" }], undefined, 1);
    expect(rootIds(middle.elements)).toEqual(["secaaa", middle.topIds[0], "secbbb"]);
    expect(() => bricks.validate(middle.elements)).not.toThrow();
  });
  it("refuses an unknown parent", () => {
    expect(() => bricks.addElements(page(), spec, "zzzzzz")).toThrow(/No element/);
  });
});

describe("removeElement", () => {
  it("removes the element with its descendants and unlinks it", () => {
    const { elements, removedIds } = bricks.removeElement(page(), "conaaa");
    expect(removedIds.sort()).toEqual(["conaaa", "headaa", "textaa"]);
    expect(elements.map((e) => e.id)).toEqual(["secaaa", "secbbb"]);
    expect(get(elements, "secaaa").children).toEqual([]);
    expect(() => bricks.validate(elements)).not.toThrow();
  });
});

describe("moveElement", () => {
  it("moves a subtree to another parent", () => {
    const elements = bricks.moveElement(page(), "conaaa", "secbbb");
    expect(get(elements, "secaaa").children).toEqual([]);
    expect(get(elements, "secbbb").children).toEqual(["conaaa"]);
    expect(get(elements, "headaa").parent).toBe("conaaa");
    expect(elements).toHaveLength(5);
    expect(() => bricks.validate(elements)).not.toThrow();
  });
  it("reorders siblings and root sections", () => {
    const siblings = bricks.moveElement(page(), "textaa", "conaaa", 0);
    expect(get(siblings, "conaaa").children).toEqual(["textaa", "headaa"]);
    const roots = bricks.moveElement(page(), "secbbb", undefined, 0);
    expect(rootIds(roots)).toEqual(["secbbb", "secaaa"]);
    const toRoot = bricks.moveElement(page(), "headaa");
    expect(rootIds(toRoot)).toEqual(["secaaa", "secbbb", "headaa"]);
    expect(get(toRoot, "headaa").parent).toBe(0);
    for (const els of [siblings, roots, toRoot]) expect(() => bricks.validate(els)).not.toThrow();
  });
  it("refuses to move an element into itself", () => {
    expect(() => bricks.moveElement(page(), "secaaa", "headaa")).toThrow(/inside itself/);
  });
});

describe("updateElement", () => {
  it("merges, removes and replaces settings", () => {
    const els = page();
    bricks.updateElement(els, "headaa", { settings: { text: "New" }, label: "Title" });
    expect(get(els, "headaa")).toMatchObject({ settings: { text: "New", tag: "h1" }, label: "Title" });
    bricks.updateElement(els, "headaa", { removeSettings: ["tag"], label: "" });
    expect(get(els, "headaa").settings).toEqual({ text: "New" });
    expect(get(els, "headaa").label).toBeUndefined();
    bricks.updateElement(els, "headaa", { settings: { tag: "h2" }, replaceSettings: true });
    expect(get(els, "headaa").settings).toEqual({ tag: "h2" });
  });
});
