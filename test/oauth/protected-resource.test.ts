import { describe, expect, test } from "bun:test";
import { OAUTH_PATHS, createOAuthHandler } from "../../src/oauth/endpoints.ts";
import { InMemoryOAuthStore } from "../../src/oauth/store.ts";

const makeHandler = (issuer = "http://localhost:3847") => {
  const store = new InMemoryOAuthStore();
  const handler = createOAuthHandler({ store, issuer, accessTokenTtlSec: 3600 });
  return handler;
};

describe("GET /.well-known/oauth-protected-resource (RFC 9728)", () => {
  test("returns 200 with resource, authorization_servers, scopes, bearer methods", async () => {
    const handler = makeHandler("http://localhost:3847");
    const res = await handler(
      new Request("http://localhost:3847/.well-known/oauth-protected-resource"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    expect(body.resource).toBe("http://localhost:3847/mcp");
    expect(body.authorization_servers).toEqual(["http://localhost:3847"]);
    expect(body.scopes_supported).toContain("mcp");
    expect(body.bearer_methods_supported).toContain("header");
  });

  test("reflects a prefixed issuer in the resource and authorization_servers URLs", async () => {
    const prefixed = "https://host.example/cortex";
    const handler = makeHandler(prefixed);
    const res = await handler(new Request("http://internal/.well-known/oauth-protected-resource"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(body.resource).toBe(`${prefixed}/mcp`);
    expect(body.authorization_servers).toEqual([prefixed]);
  });

  test("returns 404 for non-GET methods", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://localhost:3847/.well-known/oauth-protected-resource", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("OAUTH_PATHS registration", () => {
  test("includes /.well-known/oauth-protected-resource so the dispatcher routes it", () => {
    expect(OAUTH_PATHS.has("/.well-known/oauth-protected-resource")).toBe(true);
  });

  test("still includes the existing OAuth paths (regression-safe)", () => {
    expect(OAUTH_PATHS.has("/authorize")).toBe(true);
    expect(OAUTH_PATHS.has("/token")).toBe(true);
    expect(OAUTH_PATHS.has("/.well-known/oauth-authorization-server")).toBe(true);
  });
});
