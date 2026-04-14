import { describe, expect, test } from "bun:test";
import { OAUTH_PATHS, createOAuthHandler } from "../../src/oauth/endpoints.ts";
import { InMemoryOAuthStore } from "../../src/oauth/store.ts";

const ISSUER = "http://localhost:3847";

const makeHandler = (issuer = ISSUER) =>
  createOAuthHandler({ store: new InMemoryOAuthStore(), issuer, accessTokenTtlSec: 3600 });

describe("GET /.well-known/openid-configuration", () => {
  test("returns the same JSON body as /.well-known/oauth-authorization-server", async () => {
    const handler = makeHandler();
    const oauth = await (
      await handler(new Request(`${ISSUER}/.well-known/oauth-authorization-server`))
    ).json();
    const oidc = await (
      await handler(new Request(`${ISSUER}/.well-known/openid-configuration`))
    ).json();
    expect(oidc).toEqual(oauth);
  });

  test("reflects a prefixed issuer (discovery URLs include the prefix)", async () => {
    const prefixed = "https://host.example/cortex";
    const handler = makeHandler(prefixed);
    const res = await handler(new Request("http://internal/.well-known/openid-configuration"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
    };
    expect(body.issuer).toBe(prefixed);
    expect(body.authorization_endpoint).toBe(`${prefixed}/authorize`);
    expect(body.token_endpoint).toBe(`${prefixed}/token`);
    expect(body.registration_endpoint).toBe(`${prefixed}/register`);
  });

  test("returns 404 for non-GET methods", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request(`${ISSUER}/.well-known/openid-configuration`, { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("OAUTH_PATHS registration", () => {
  test("includes /.well-known/openid-configuration so the dispatcher routes it", () => {
    expect(OAUTH_PATHS.has("/.well-known/openid-configuration")).toBe(true);
  });
});
