import { beforeEach, describe, expect, test } from "bun:test";
import { createOAuthHandler } from "../../src/oauth/endpoints.ts";
import { InMemoryOAuthStore } from "../../src/oauth/store.ts";

const CLIENT_ID = "claude-mcp";
const REDIRECT_URI = "http://localhost:3000/cb";
const ISSUER = "http://localhost:3847";
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

async function exchangeCodeForTokens(
  handler: (r: Request) => Promise<Response>,
): Promise<{ accessToken: string; refreshToken: string }> {
  const authUrl = new URL(`${ISSUER}/authorize`);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", CHALLENGE);
  authUrl.searchParams.set("code_challenge_method", "S256");
  const authBody = new URLSearchParams({ password: AUTH_PASSWORD });
  const authRes = await handler(
    new Request(authUrl.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: authBody.toString(),
    }),
  );
  const code = new URL(authRes.headers.get("location") as string).searchParams.get("code");
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code as string);
  body.set("redirect_uri", REDIRECT_URI);
  body.set("client_id", CLIENT_ID);
  body.set("code_verifier", VERIFIER);
  const tokRes = await handler(
    new Request(`${ISSUER}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
  );
  const j = (await tokRes.json()) as { access_token: string; refresh_token: string };
  return { accessToken: j.access_token, refreshToken: j.refresh_token };
}

describe("POST /token — refresh_token grant with rotation", () => {
  let handler: (r: Request) => Promise<Response>;
  let refreshToken: string;

  beforeEach(async () => {
    const env = makeHandler();
    handler = env.handler;
    const tokens = await exchangeCodeForTokens(handler);
    refreshToken = tokens.refreshToken;
  });

  test("valid refresh_token returns a new access+refresh pair", async () => {
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refreshToken);
    body.set("client_id", CLIENT_ID);
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(j.access_token).toBeTruthy();
    expect(j.refresh_token).toBeTruthy();
    expect(j.refresh_token).not.toBe(refreshToken);
    expect(j.token_type).toBe("Bearer");
    expect(j.expires_in).toBe(3600);
  });

  test("reusing an already-rotated refresh_token returns 400 invalid_grant (reuse detection)", async () => {
    const first = new URLSearchParams();
    first.set("grant_type", "refresh_token");
    first.set("refresh_token", refreshToken);
    first.set("client_id", CLIENT_ID);
    const r1 = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: first.toString(),
      }),
    );
    expect(r1.status).toBe(200);

    // Replay original (now rotated)
    const replay = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: first.toString(),
      }),
    );
    expect(replay.status).toBe(400);
    const j = (await replay.json()) as { error: string };
    expect(j.error).toBe("invalid_grant");
  });

  test("unknown refresh_token returns 400 invalid_grant", async () => {
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", "not-a-real-token");
    body.set("client_id", CLIENT_ID);
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("refresh_token with mismatched client_id returns 400", async () => {
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refreshToken);
    body.set("client_id", "other-client");
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
