import { beforeEach, describe, expect, test } from "bun:test";
import { authMiddleware } from "../../src/oauth/middleware.ts";
import { InMemoryOAuthStore } from "../../src/oauth/store.ts";

const ISSUER = "http://localhost:3847";

describe("authMiddleware", () => {
  let store: InMemoryOAuthStore;
  const inner = async (_req: Request): Promise<Response> => new Response("inner-ok");

  beforeEach(() => {
    store = new InMemoryOAuthStore();
    store.putAccessToken({
      token: "valid",
      clientId: "c1",
      expiresAt: Date.now() + 3600_000,
    });
    store.putAccessToken({
      token: "expired",
      clientId: "c1",
      expiresAt: Date.now() - 1,
    });
  });

  test("passes request through when Authorization header has a valid Bearer token", async () => {
    const handler = authMiddleware({ store, issuer: ISSUER })(inner);
    const res = await handler(
      new Request("http://x/mcp", { headers: { authorization: "Bearer valid" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("inner-ok");
  });

  test("returns 401 with WWW-Authenticate when Authorization header is missing", async () => {
    const handler = authMiddleware({ store, issuer: ISSUER })(inner);
    const res = await handler(new Request("http://x/mcp"));
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate");
    expect(www).not.toBeNull();
    expect(www?.toLowerCase()).toContain("bearer");
    expect(www).toContain("resource_metadata");
  });

  test("WWW-Authenticate resource_metadata points at oauth-protected-resource, not authorization-server (RFC 9728 §5.1)", async () => {
    const handler = authMiddleware({ store, issuer: ISSUER })(inner);
    const res = await handler(new Request("http://x/mcp"));
    const www = res.headers.get("www-authenticate") ?? "";
    expect(www).toContain(`${ISSUER}/.well-known/oauth-protected-resource`);
    expect(www).not.toContain("/.well-known/oauth-authorization-server");
  });

  test("returns 401 for non-Bearer schemes (e.g. Basic)", async () => {
    const handler = authMiddleware({ store, issuer: ISSUER })(inner);
    const res = await handler(
      new Request("http://x/mcp", { headers: { authorization: "Basic abc" } }),
    );
    expect(res.status).toBe(401);
  });

  test("returns 401 for an unknown token", async () => {
    const handler = authMiddleware({ store, issuer: ISSUER })(inner);
    const res = await handler(
      new Request("http://x/mcp", { headers: { authorization: "Bearer nonexistent" } }),
    );
    expect(res.status).toBe(401);
  });

  test("returns 401 with error=invalid_token when the token is expired", async () => {
    const handler = authMiddleware({ store, issuer: ISSUER })(inner);
    const res = await handler(
      new Request("http://x/mcp", { headers: { authorization: "Bearer expired" } }),
    );
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate");
    expect(www?.toLowerCase()).toContain("invalid_token");
  });

  test("re-checks expiry on every request (not cached)", async () => {
    const handler = authMiddleware({ store, issuer: ISSUER })(inner);
    const shortLived = "short";
    store.putAccessToken({ token: shortLived, clientId: "c1", expiresAt: Date.now() + 20 });
    const r1 = await handler(
      new Request("http://x/mcp", { headers: { authorization: `Bearer ${shortLived}` } }),
    );
    expect(r1.status).toBe(200);
    await new Promise((r) => setTimeout(r, 40));
    const r2 = await handler(
      new Request("http://x/mcp", { headers: { authorization: `Bearer ${shortLived}` } }),
    );
    expect(r2.status).toBe(401);
  });
});
