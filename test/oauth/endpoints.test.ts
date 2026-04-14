import { describe, expect, test } from "bun:test";
import { createOAuthHandler } from "../../src/oauth/endpoints.ts";
import { InMemoryOAuthStore } from "../../src/oauth/store.ts";

const CLIENT_ID = "claude-mcp";
const REDIRECT_URI = "http://localhost:3000/cb";
const ISSUER = "http://localhost:3847";

// S256 pair from RFC 7636
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const AUTH_PASSWORD = "test-password";

const makeHandler = () => {
  const store = new InMemoryOAuthStore();
  store.registerClient({ clientId: CLIENT_ID, redirectUris: [REDIRECT_URI] });
  const handler = createOAuthHandler({
    store,
    issuer: ISSUER,
    accessTokenTtlSec: 3600,
    authPassword: AUTH_PASSWORD,
  });
  return { handler, store };
};

describe("GET /.well-known/oauth-authorization-server", () => {
  test("returns authorization_endpoint, token_endpoint, supported methods", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request(`${ISSUER}/.well-known/oauth-authorization-server`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      response_types_supported: string[];
      grant_types_supported: string[];
      code_challenge_methods_supported: string[];
    };
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/token`);
    expect(body.response_types_supported).toContain("code");
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.grant_types_supported).toContain("refresh_token");
    expect(body.code_challenge_methods_supported).toContain("S256");
  });

  test("when issuer carries a base-path, discovery URLs include the prefix", async () => {
    // The oauth handler doesn't know about base paths — createUnifiedHandler
    // strips the prefix before forwarding. This test validates that setting
    // CORTEX_OAUTH_ISSUER to include the prefix is enough to produce
    // correctly-prefixed discovery + metadata URLs.
    const store = new InMemoryOAuthStore();
    store.registerClient({ clientId: CLIENT_ID, redirectUris: [REDIRECT_URI] });
    const prefixedIssuer = "https://host.example/cortex";
    const handler = createOAuthHandler({
      store,
      issuer: prefixedIssuer,
      accessTokenTtlSec: 3600,
    });
    const res = await handler(
      new Request("http://internal/.well-known/oauth-authorization-server"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
    };
    expect(body.issuer).toBe(prefixedIssuer);
    expect(body.authorization_endpoint).toBe(`${prefixedIssuer}/authorize`);
    expect(body.token_endpoint).toBe(`${prefixedIssuer}/token`);
  });
});

describe("POST /authorize (with correct password)", () => {
  test("redirects to redirect_uri with a code and the original state preserved", async () => {
    const { handler } = makeHandler();
    const url = new URL(`${ISSUER}/authorize`);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "xyz");
    const body = new URLSearchParams({ password: AUTH_PASSWORD });
    const res = await handler(
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const redirect = new URL(location as string);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get("state")).toBe("xyz");
    expect(redirect.searchParams.get("code")).not.toBeNull();
  });

  test("rejects unknown client_id with 400", async () => {
    const { handler } = makeHandler();
    const url = new URL(`${ISSUER}/authorize`);
    url.searchParams.set("client_id", "nope");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handler(new Request(url.toString()));
    expect(res.status).toBe(400);
  });

  test("rejects redirect_uri not in client's registered list with 400", async () => {
    const { handler } = makeHandler();
    const url = new URL(`${ISSUER}/authorize`);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", "http://evil.example/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handler(new Request(url.toString()));
    expect(res.status).toBe(400);
  });

  test("rejects response_type != code with 400", async () => {
    const { handler } = makeHandler();
    const url = new URL(`${ISSUER}/authorize`);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "token");
    url.searchParams.set("code_challenge", CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handler(new Request(url.toString()));
    expect(res.status).toBe(400);
  });

  test("rejects missing PKCE code_challenge with 400", async () => {
    const { handler } = makeHandler();
    const url = new URL(`${ISSUER}/authorize`);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    const res = await handler(new Request(url.toString()));
    expect(res.status).toBe(400);
  });
});

describe("POST /token — authorization_code grant", () => {
  async function getCode(handler: (r: Request) => Promise<Response>): Promise<string> {
    const url = new URL(`${ISSUER}/authorize`);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");
    const body = new URLSearchParams({ password: AUTH_PASSWORD });
    const res = await handler(
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    const loc = res.headers.get("location");
    const code = new URL(loc as string).searchParams.get("code");
    if (code === null) throw new Error("no code");
    return code;
  }

  test("valid code + verifier returns access_token, refresh_token, expires_in", async () => {
    const { handler } = makeHandler();
    const code = await getCode(handler);
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", REDIRECT_URI);
    body.set("client_id", CLIENT_ID);
    body.set("code_verifier", VERIFIER);
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(json.access_token).toBeTruthy();
    expect(json.refresh_token).toBeTruthy();
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBe(3600);
  });

  test("wrong verifier rejects with 400 invalid_grant", async () => {
    const { handler } = makeHandler();
    const code = await getCode(handler);
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", REDIRECT_URI);
    body.set("client_id", CLIENT_ID);
    body.set("code_verifier", "not-the-verifier");
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_grant");
  });

  test("code can only be redeemed once", async () => {
    const { handler } = makeHandler();
    const code = await getCode(handler);
    const mkBody = () => {
      const body = new URLSearchParams();
      body.set("grant_type", "authorization_code");
      body.set("code", code);
      body.set("redirect_uri", REDIRECT_URI);
      body.set("client_id", CLIENT_ID);
      body.set("code_verifier", VERIFIER);
      return body.toString();
    };
    const req = () =>
      handler(
        new Request(`${ISSUER}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: mkBody(),
        }),
      );
    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(400);
  });

  test("mismatched redirect_uri rejects with 400", async () => {
    const { handler } = makeHandler();
    const code = await getCode(handler);
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", "http://other.example/cb");
    body.set("client_id", CLIENT_ID);
    body.set("code_verifier", VERIFIER);
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    expect(res.status).toBe(400);
  });
});
