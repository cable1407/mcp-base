import { describe, expect, test } from "bun:test";
import { withCors } from "../src/cors.ts";

type Handler = (req: Request) => Promise<Response>;

const innerOk = async (_req: Request): Promise<Response> =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const innerWithWww: Handler = async () =>
  new Response(null, {
    status: 401,
    headers: {
      "www-authenticate":
        'Bearer realm="cortex", resource_metadata="https://x/.well-known/oauth-protected-resource"',
    },
  });

describe("withCors — OPTIONS preflight", () => {
  test("returns 204 for OPTIONS requests (no body)", async () => {
    const h = withCors(innerOk);
    const res = await h(
      new Request("http://x/mcp", {
        method: "OPTIONS",
        headers: {
          origin: "https://claude.ai",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type, authorization",
        },
      }),
    );
    expect(res.status).toBe(204);
  });

  test("preflight response carries allow-origin, allow-methods, allow-headers, expose-headers, max-age", async () => {
    const h = withCors(innerOk);
    const res = await h(
      new Request("http://x/mcp", {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai" },
      }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const methods = (res.headers.get("access-control-allow-methods") ?? "").toUpperCase();
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(methods).toContain("DELETE");
    expect(methods).toContain("OPTIONS");
    const allowHeaders = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowHeaders).toContain("content-type");
    expect(allowHeaders).toContain("authorization");
    expect(allowHeaders).toContain("mcp-session-id");
    expect(allowHeaders).toContain("mcp-protocol-version");
    const exposeHeaders = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    expect(exposeHeaders).toContain("mcp-session-id");
    expect(exposeHeaders).toContain("www-authenticate");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  test("OPTIONS does not call the inner handler", async () => {
    let innerCalled = false;
    const inner: Handler = async () => {
      innerCalled = true;
      return new Response("nope");
    };
    const h = withCors(inner);
    await h(new Request("http://x/mcp", { method: "OPTIONS" }));
    expect(innerCalled).toBe(false);
  });
});

describe("withCors — non-OPTIONS responses", () => {
  test("adds Access-Control-Allow-Origin: * to successful responses", async () => {
    const h = withCors(innerOk);
    const res = await h(new Request("http://x/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("adds Access-Control-Expose-Headers with Mcp-Session-Id and WWW-Authenticate", async () => {
    const h = withCors(innerOk);
    const res = await h(new Request("http://x/health"));
    const expose = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    expect(expose).toContain("mcp-session-id");
    expect(expose).toContain("www-authenticate");
  });

  test("preserves the original status code", async () => {
    const h = withCors(innerWithWww);
    const res = await h(new Request("http://x/mcp", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  test("preserves existing headers from the inner response (e.g. WWW-Authenticate)", async () => {
    const h = withCors(innerWithWww);
    const res = await h(new Request("http://x/mcp", { method: "POST" }));
    const www = res.headers.get("www-authenticate");
    expect(www).not.toBeNull();
    expect(www).toContain("Bearer");
  });

  test("preserves the response body", async () => {
    const h = withCors(innerOk);
    const res = await h(new Request("http://x/health"));
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("does not add the method/header/max-age CORS directives to normal responses (preflight-only)", async () => {
    const h = withCors(innerOk);
    const res = await h(new Request("http://x/health"));
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
    expect(res.headers.get("access-control-max-age")).toBeNull();
  });
});
