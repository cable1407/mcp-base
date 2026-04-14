import { describe, expect, test } from "bun:test";
import { verifyPkce } from "../../src/oauth/pkce.ts";

describe("PKCE verifyPkce", () => {
  test("S256: returns true when challenge === base64url(sha256(verifier))", () => {
    // Known good pair from RFC 7636 §4.4 appendix
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(verifyPkce({ verifier, challenge, method: "S256" })).toBe(true);
  });

  test("S256: returns false when the verifier doesn't hash to the challenge", () => {
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(verifyPkce({ verifier: "wrongverifier", challenge, method: "S256" })).toBe(false);
  });

  test("plain: returns true when verifier === challenge", () => {
    expect(verifyPkce({ verifier: "abc", challenge: "abc", method: "plain" })).toBe(true);
  });

  test("plain: returns false when verifier !== challenge", () => {
    expect(verifyPkce({ verifier: "abc", challenge: "xyz", method: "plain" })).toBe(false);
  });

  test("rejects unknown method", () => {
    expect(() => verifyPkce({ verifier: "x", challenge: "x", method: "MD5" as "S256" })).toThrow();
  });
});
