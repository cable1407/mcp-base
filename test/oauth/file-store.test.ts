import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileOAuthStore } from "../../src/oauth/file-store.ts";

describe("FileOAuthStore", () => {
  let tmp: string;
  let filePath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-oauth-"));
    filePath = path.join(tmp, "oauth.json");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("creates the file on first write with a flushed JSON state", () => {
    const store = new FileOAuthStore(filePath);
    store.registerClient({ clientId: "c1", redirectUris: ["http://x/cb"] });
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      clients: Record<string, unknown>;
    };
    expect(raw.clients.c1).toBeDefined();
  });

  test("persists access tokens across a simulated restart (new store instance reads file)", () => {
    const s1 = new FileOAuthStore(filePath);
    s1.putAccessToken({ token: "at-1", clientId: "c1", expiresAt: Date.now() + 3600_000 });
    const s2 = new FileOAuthStore(filePath);
    const found = s2.findAccessToken("at-1");
    expect(found).not.toBeNull();
    expect(found?.clientId).toBe("c1");
  });

  test("persists refresh tokens across restart with rotated flag intact", () => {
    const s1 = new FileOAuthStore(filePath);
    s1.putRefreshToken({ token: "rt-1", clientId: "c1", issuedAt: Date.now(), rotated: false });
    s1.markRefreshRotated("rt-1");
    const s2 = new FileOAuthStore(filePath);
    expect(s2.findRefreshToken("rt-1")?.rotated).toBe(true);
  });

  test("persists clients across restart", () => {
    const s1 = new FileOAuthStore(filePath);
    s1.registerClient({ clientId: "c1", redirectUris: ["http://x/cb"] });
    const s2 = new FileOAuthStore(filePath);
    expect(s2.findClient("c1")).toEqual({
      clientId: "c1",
      redirectUris: ["http://x/cb"],
    });
  });

  test("consumeCode is still single-use after persistence", () => {
    const s1 = new FileOAuthStore(filePath);
    s1.putCode({
      code: "abc",
      clientId: "c1",
      redirectUri: "http://x/cb",
      codeChallenge: "ch",
      codeChallengeMethod: "S256",
      expiresAt: Date.now() + 60_000,
    });
    expect(s1.consumeCode("abc")).not.toBeNull();
    const s2 = new FileOAuthStore(filePath);
    expect(s2.consumeCode("abc")).toBeNull();
  });

  test("constructs cleanly when the file does not yet exist", () => {
    expect(() => new FileOAuthStore(filePath)).not.toThrow();
  });

  test("returns null for unknown tokens after restart (no ghost state)", () => {
    new FileOAuthStore(filePath).registerClient({
      clientId: "c1",
      redirectUris: ["http://x/cb"],
    });
    const s2 = new FileOAuthStore(filePath);
    expect(s2.findAccessToken("never-issued")).toBeNull();
    expect(s2.findRefreshToken("never-issued")).toBeNull();
    expect(s2.findClient("nope")).toBeNull();
  });
});
