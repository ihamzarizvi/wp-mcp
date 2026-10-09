import { describe, expect, it } from "vitest";
import { parseSites } from "../src/config.js";
import { GuardError, guard, redact } from "../src/safety.js";
import { methodKind } from "../src/tools/helpers.js";
import { mimeFor } from "../src/tools/media.js";
import { resourceRoute } from "../src/tools/resources.js";
import { classifyCli, classifySql, splitArgs } from "../src/tools/system.js";
import { tokenMatches } from "../src/transports/http.js";
import { buildUrl } from "../src/wp-client.js";

const site = { id: "a", url: "https://example.com/", username: "u", appPasswordEnv: "PW" };

describe("config", () => {
  it("resolves the password from env and trims the trailing slash", () => {
    const s = parseSites({ sites: [site] }, { PW: "secret" }).get("a");
    expect(s).toMatchObject({ url: "https://example.com", auth: { type: "basic", username: "u", password: "secret" }, readOnly: false });
  });
  it("accepts a connection key over https or localhost only", () => {
    const key = (url: string) => parseSites({ sites: [{ id: "k", url, keyEnv: "K" }] }, { K: "wpmcp_x" });
    expect(key("https://example.com").get("k").auth).toEqual({ type: "key", key: "wpmcp_x" });
    expect(key("http://127.0.0.1:9400").get("k").auth.type).toBe("key");
    expect(() => key("http://example.com")).toThrow(/https/);
  });
  it("requires exactly one auth method", () => {
    expect(() => parseSites({ sites: [{ id: "a", url: "https://x.com" }] }, {})).toThrow(/keyEnv/);
    expect(() => parseSites({ sites: [{ ...site, keyEnv: "K" }] }, { PW: "x", K: "y" })).toThrow(/keyEnv/);
  });
  it("fails when the env var is missing", () => {
    expect(() => parseSites({ sites: [site] }, {})).toThrow(/PW is not set/);
  });
  it("rejects duplicate ids and unknown lookups", () => {
    expect(() => parseSites({ sites: [site, site] }, { PW: "x" })).toThrow(/Duplicate/);
    expect(() => parseSites({ sites: [site] }, { PW: "x" }).get("nope")).toThrow(/Unknown site/);
  });
});

describe("guard", () => {
  const rw = { id: "a", readOnly: false };
  const ro = { id: "a", readOnly: true };
  it("always allows reads", () => {
    expect(() => guard(ro, "t", "read", undefined)).not.toThrow();
  });
  it("blocks writes on read-only sites even when confirmed", () => {
    expect(() => guard(ro, "t", "write", true)).toThrow(GuardError);
    expect(() => guard(ro, "t", "destructive", true)).toThrow(GuardError);
  });
  it("requires confirm: true for destructive calls", () => {
    expect(() => guard(rw, "t", "write", undefined)).not.toThrow();
    expect(() => guard(rw, "t", "destructive", undefined)).toThrow(/confirm/);
    expect(() => guard(rw, "t", "destructive", "true")).toThrow(/confirm/);
    expect(() => guard(rw, "t", "destructive", true)).not.toThrow();
  });
});

describe("redact", () => {
  it("hides secrets at any depth and shortens long strings", () => {
    const out = redact({ data: { password: "p", name: "n" }, api_key: "k", content: "x".repeat(600) }) as any;
    expect(out.data).toEqual({ password: "[redacted]", name: "n" });
    expect(out.api_key).toBe("[redacted]");
    expect(out.content.length).toBeLessThan(600);
  });
});

describe("buildUrl", () => {
  it("builds pretty and plain permalink URLs", () => {
    expect(buildUrl({ url: "https://x.com", plainPermalinks: false }, "/wp/v2/posts", { per_page: 5, _fields: ["id", "slug"], skip: undefined }))
      .toBe("https://x.com/wp-json/wp/v2/posts?per_page=5&_fields=id%2Cslug");
    expect(buildUrl({ url: "https://x.com", plainPermalinks: true }, "/wp/v2/posts", { page: 2 }))
      .toBe("https://x.com/?rest_route=%2Fwp%2Fv2%2Fposts&page=2");
  });
});

describe("routes and kinds", () => {
  it("maps resources to routes", () => {
    expect(resourceRoute("posts")).toBe("/wp/v2/posts");
    expect(resourceRoute("menu-items", 7)).toBe("/wp/v2/menu-items/7");
    expect(resourceRoute("/wc/v3/products/", 3)).toBe("/wc/v3/products/3");
  });
  it("classifies HTTP methods", () => {
    expect([methodKind("GET"), methodKind("POST"), methodKind("DELETE")]).toEqual(["read", "write", "destructive"]);
  });
  it("guesses mime types", () => {
    expect(mimeFor("A.JPG")).toBe("image/jpeg");
    expect(mimeFor("x.unknown")).toBe("application/octet-stream");
  });
});

describe("wp-cli parsing", () => {
  it("splits quoted arguments", () => {
    expect(splitArgs(`post create --post_title="Hello world" --x='a "b"' ""`)).toEqual([
      "post", "create", "--post_title=Hello world", '--x=a "b"', "",
    ]);
    expect(() => splitArgs('a "b')).toThrow(/Unterminated/);
  });
  it("treats only known read commands as reads", () => {
    for (const c of ["plugin list --format=json", "wp option get home", "user meta get 1 nickname", "core version", "--info", "db size"]) {
      expect(classifyCli(c), c).toBe("read");
    }
    for (const c of ["plugin delete akismet", "db query 'DROP TABLE x'", "search-replace get new", "eval list", "option update status 1", "cache flush", "db drop --yes"]) {
      expect(classifyCli(c), c).toBe("destructive");
    }
  });
});

describe("sql classification", () => {
  it("allows single read statements only", () => {
    expect(classifySql("  select * from {prefix}posts limit 1;")).toBe("read");
    expect(classifySql("/* c */ SHOW TABLES")).toBe("read");
    expect(classifySql("-- note\nEXPLAIN SELECT 1")).toBe("read");
    expect(classifySql("UPDATE x SET a=1")).toBe("destructive");
    expect(classifySql("SELECT 1; DROP TABLE x")).toBe("destructive");
    expect(classifySql("/* select */ DELETE FROM x")).toBe("destructive");
  });
});

describe("bearer token", () => {
  it("accepts only the exact token", () => {
    expect(tokenMatches("Bearer abc", "abc")).toBe(true);
    expect(tokenMatches("Bearer abd", "abc")).toBe(false);
    expect(tokenMatches("abc", "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
  });
});
