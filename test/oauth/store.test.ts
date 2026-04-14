import { beforeEach, describe, expect, test } from "bun:test";
import { InMemoryOAuthStore } from "../../src/oauth/store.ts";
import type {
  AccessToken,
  AuthorizationCode,
  OAuthClient,
  RefreshToken,
} from "../../src/oauth/types.ts";

describe("InMemoryOAuthStore", () => {
  let store: InMemoryOAuthStore;
  beforeEach(() => {
    store = new InMemoryOAuthStore();
  });

  describe("clients", () => {
    test("registerClient then findClient by id round-trips", () => {
      const client: OAuthClient = {
        clientId: "c1",
        redirectUris: ["http://localhost:3000/cb"],
      };
      store.registerClient(client);
      expect(store.findClient("c1")).toEqual(client);
    });

    test("findClient returns null for unknown id", () => {
      expect(store.findClient("nope")).toBeNull();
    });
  });

  describe("authorization codes", () => {
    test("putCode then consumeCode returns the code exactly once", () => {
      const code: AuthorizationCode = {
        code: "abc",
        clientId: "c1",
        redirectUri: "http://x/cb",
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        expiresAt: Date.now() + 60_000,
      };
      store.putCode(code);
      expect(store.consumeCode("abc")).toEqual(code);
      expect(store.consumeCode("abc")).toBeNull();
    });

    test("consumeCode returns null for unknown code", () => {
      expect(store.consumeCode("missing")).toBeNull();
    });

    test("consumeCode returns null for expired code and removes it", () => {
      store.putCode({
        code: "old",
        clientId: "c1",
        redirectUri: "http://x/cb",
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        expiresAt: Date.now() - 1,
      });
      expect(store.consumeCode("old")).toBeNull();
    });
  });

  describe("access tokens", () => {
    test("putAccessToken then findAccessToken round-trips", () => {
      const token: AccessToken = {
        token: "at-1",
        clientId: "c1",
        expiresAt: Date.now() + 3600_000,
      };
      store.putAccessToken(token);
      expect(store.findAccessToken("at-1")).toEqual(token);
    });

    test("findAccessToken returns null for unknown token", () => {
      expect(store.findAccessToken("nope")).toBeNull();
    });
  });

  describe("refresh tokens", () => {
    test("putRefreshToken then findRefreshToken round-trips", () => {
      const token: RefreshToken = {
        token: "rt-1",
        clientId: "c1",
        issuedAt: Date.now(),
        rotated: false,
      };
      store.putRefreshToken(token);
      expect(store.findRefreshToken("rt-1")).toEqual(token);
    });

    test("markRefreshRotated flips the rotated flag", () => {
      store.putRefreshToken({
        token: "rt-1",
        clientId: "c1",
        issuedAt: Date.now(),
        rotated: false,
      });
      store.markRefreshRotated("rt-1");
      expect(store.findRefreshToken("rt-1")?.rotated).toBe(true);
    });
  });
});
