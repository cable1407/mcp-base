import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ExtraRoute,
  type Handler,
  type McpServer,
  type McpServerConfig,
  createMcpServer,
} from "../src/index.ts";

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mcp-base-"));

const makeServer = async (overrides: Partial<McpServerConfig> = {}): Promise<McpServer> => {
  const mcpHandler: Handler = async () =>
    new Response(JSON.stringify({ ok: "mcp" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const server = await createMcpServer({
    name: "test",
    port: 0,
    mcpHandler,
    accessLog: false,
    ...overrides,
  });
  server.listen();
  return server;
};

const url = (server: McpServer, path: string): string => `http://localhost:${server.port}${path}`;

describe("createMcpServer — wiring", () => {
  let server: McpServer;
  afterEach(async () => {
    if (server) await server.stop();
  });

  test("routes POST /mcp to the supplied mcpHandler", async () => {
    server = await makeServer();
    const res = await fetch(url(server, "/mcp"), { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: string };
    expect(body.ok).toBe("mcp");
  });

  test("GET /mcp returns 405 Method Not Allowed (from the dispatcher, before auth)", async () => {
    server = await makeServer();
    const res = await fetch(url(server, "/mcp"));
    expect(res.status).toBe(405);
    const allow = (res.headers.get("allow") ?? "").toUpperCase();
    expect(allow).toContain("POST");
  });

  test("OPTIONS preflight returns 204 with CORS headers (from withCors)", async () => {
    server = await makeServer();
    const res = await fetch(url(server, "/mcp"), {
      method: "OPTIONS",
      headers: { origin: "https://claude.ai", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("non-OPTIONS responses carry access-control-allow-origin", async () => {
    server = await makeServer();
    const res = await fetch(url(server, "/mcp"), { method: "POST" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("unknown path returns 404", async () => {
    server = await makeServer();
    const res = await fetch(url(server, "/does-not-exist"));
    expect(res.status).toBe(404);
  });
});

describe("createMcpServer — extraRoutes", () => {
  let server: McpServer;
  afterEach(async () => {
    if (server) await server.stop();
  });

  test("public extra route is accessible without auth", async () => {
    const healthHandler: Handler = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const extraRoutes: readonly ExtraRoute[] = [
      { method: "GET", path: "/health", handler: healthHandler, public: true },
    ];
    server = await makeServer({ extraRoutes });
    const res = await fetch(url(server, "/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("bearer-gated extra route returns 401 without the token", async () => {
    const pushHandler: Handler = async () => new Response("pushed", { status: 201 });
    const extraRoutes: readonly ExtraRoute[] = [
      { method: "POST", path: "/index", handler: pushHandler, requireToken: "secret" },
    ];
    server = await makeServer({ extraRoutes });
    const res = await fetch(url(server, "/index"), { method: "POST" });
    expect(res.status).toBe(401);
    expect((res.headers.get("www-authenticate") ?? "").toLowerCase()).toContain("bearer");
  });

  test("bearer-gated extra route accepts the correct token", async () => {
    const pushHandler: Handler = async () => new Response("pushed", { status: 201 });
    const extraRoutes: readonly ExtraRoute[] = [
      { method: "POST", path: "/index", handler: pushHandler, requireToken: "secret" },
    ];
    server = await makeServer({ extraRoutes });
    const res = await fetch(url(server, "/index"), {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.status).toBe(201);
  });

  test("bearer scheme is case-insensitive — BEARER, bearer, BeArEr all work", async () => {
    const pushHandler: Handler = async () => new Response("pushed", { status: 201 });
    const extraRoutes: readonly ExtraRoute[] = [
      { method: "POST", path: "/index", handler: pushHandler, requireToken: "secret" },
    ];
    server = await makeServer({ extraRoutes });
    for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
      const res = await fetch(url(server, "/index"), {
        method: "POST",
        headers: { authorization: `${scheme} secret` },
      });
      expect(res.status).toBe(201);
    }
  });

  test("unknown path under extras returns 404", async () => {
    const extraRoutes: readonly ExtraRoute[] = [
      {
        method: "GET",
        path: "/health",
        handler: async () => new Response("ok"),
        public: true,
      },
    ];
    server = await makeServer({ extraRoutes });
    const res = await fetch(url(server, "/elsewhere"));
    expect(res.status).toBe(404);
  });
});

describe("createMcpServer — OAuth wiring", () => {
  let server: McpServer;
  let storeDir: string;

  beforeEach(() => {
    storeDir = tmpDir();
  });
  afterEach(async () => {
    if (server) await server.stop();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  test("OAuth enabled: /mcp without bearer returns 401 with WWW-Authenticate", async () => {
    server = await makeServer({
      oauth: {
        enabled: true,
        issuer: "http://localhost",
        storePath: path.join(storeDir, "oauth.json"),
        accessTokenTtlSec: 3600,
        authPassword: "p",
      },
    });
    const res = await fetch(url(server, "/mcp"), { method: "POST" });
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate") ?? "";
    expect(www.toLowerCase()).toContain("bearer");
    expect(www).toContain("resource_metadata");
  });

  test("OAuth enabled: /.well-known/oauth-authorization-server is served", async () => {
    server = await makeServer({
      oauth: {
        enabled: true,
        issuer: "http://localhost",
        storePath: path.join(storeDir, "oauth.json"),
        accessTokenTtlSec: 3600,
        authPassword: "p",
      },
    });
    const res = await fetch(url(server, "/.well-known/oauth-authorization-server"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string; authorization_endpoint: string };
    expect(body.issuer).toBe("http://localhost");
    expect(body.authorization_endpoint).toBe("http://localhost/authorize");
  });

  test("OAuth enabled but no authPassword → throws at createMcpServer", async () => {
    await expect(
      createMcpServer({
        name: "test",
        port: 0,
        mcpHandler: async () => new Response(),
        accessLog: false,
        oauth: {
          enabled: true,
          issuer: "http://localhost",
          storePath: path.join(storeDir, "oauth.json"),
          accessTokenTtlSec: 3600,
          authPassword: "",
        },
      }),
    ).rejects.toThrow(/authPassword/);
  });

  test("OAuth disabled: /mcp is unauthenticated", async () => {
    server = await makeServer();
    const res = await fetch(url(server, "/mcp"), { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("createMcpServer — basePath", () => {
  let server: McpServer;
  afterEach(async () => {
    if (server) await server.stop();
  });

  test("with basePath='/cortex', /cortex/mcp routes; /mcp 404s", async () => {
    server = await makeServer({ basePath: "/cortex" });
    const ok = await fetch(url(server, "/cortex/mcp"), { method: "POST" });
    expect(ok.status).toBe(200);
    const missed = await fetch(url(server, "/mcp"), { method: "POST" });
    expect(missed.status).toBe(404);
  });
});
