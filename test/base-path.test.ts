import { describe, expect, test } from "bun:test";
import { normalizeBasePath, stripBasePath } from "../src/base-path.ts";

describe("normalizeBasePath", () => {
  test("empty string, undefined, and '/' all normalize to ''", () => {
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("/")).toBe("");
  });

  test("adds leading slash when missing", () => {
    expect(normalizeBasePath("cortex")).toBe("/cortex");
  });

  test("strips trailing slash", () => {
    expect(normalizeBasePath("/cortex/")).toBe("/cortex");
    expect(normalizeBasePath("/api/v1/")).toBe("/api/v1");
  });

  test("preserves already-normalized path", () => {
    expect(normalizeBasePath("/cortex")).toBe("/cortex");
    expect(normalizeBasePath("/api/v1")).toBe("/api/v1");
  });

  test("rejects path containing '..'", () => {
    expect(() => normalizeBasePath("/foo/../bar")).toThrow();
  });

  test("rejects path containing '?' (query)", () => {
    expect(() => normalizeBasePath("/cortex?foo=1")).toThrow();
  });

  test("rejects path containing '#' (fragment)", () => {
    expect(() => normalizeBasePath("/cortex#x")).toThrow();
  });

  test("collapses repeated slashes", () => {
    expect(normalizeBasePath("/api//v1")).toBe("/api/v1");
    expect(normalizeBasePath("//cortex")).toBe("/cortex");
    expect(normalizeBasePath("/a///b////c/")).toBe("/a/b/c");
  });
});

describe("stripBasePath", () => {
  test("returns the pathname unchanged when basePath is empty", () => {
    expect(stripBasePath("/mcp", "")).toBe("/mcp");
    expect(stripBasePath("/.well-known/oauth-authorization-server", "")).toBe(
      "/.well-known/oauth-authorization-server",
    );
  });

  test("strips the prefix from a matching pathname", () => {
    expect(stripBasePath("/cortex/mcp", "/cortex")).toBe("/mcp");
    expect(stripBasePath("/cortex/health", "/cortex")).toBe("/health");
    expect(stripBasePath("/cortex/.well-known/oauth-authorization-server", "/cortex")).toBe(
      "/.well-known/oauth-authorization-server",
    );
  });

  test("returns '/' for the base path itself (accepts both /cortex and /cortex/)", () => {
    expect(stripBasePath("/cortex", "/cortex")).toBe("/");
    expect(stripBasePath("/cortex/", "/cortex")).toBe("/");
  });

  test("returns null for a pathname that doesn't start with the prefix", () => {
    expect(stripBasePath("/mcp", "/cortex")).toBeNull();
    expect(stripBasePath("/", "/cortex")).toBeNull();
    expect(stripBasePath("/other/mcp", "/cortex")).toBeNull();
  });

  test("does not match partial-segment prefixes (e.g. /cortex2 vs /cortex)", () => {
    expect(stripBasePath("/cortex2/mcp", "/cortex")).toBeNull();
    expect(stripBasePath("/cortexfoo", "/cortex")).toBeNull();
  });
});
