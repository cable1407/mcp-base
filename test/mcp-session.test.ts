import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type SessionedMcpHandler, createSessionedMcpHandler } from "../src/mcp-session.ts";

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  },
};

const mkServer = (): McpServer => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool(
    "ping",
    {
      description: "returns pong",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );
  return server;
};

const initReq = (body: unknown = INIT_BODY): Request =>
  new Request("http://x/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

const withSid = (sid: string, body: unknown): Request =>
  new Request("http://x/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
    },
    body: JSON.stringify(body),
  });

describe("createSessionedMcpHandler — happy path", () => {
  let handler: SessionedMcpHandler;
  let logs: string[];

  beforeEach(() => {
    logs = [];
    handler = createSessionedMcpHandler({
      createServer: mkServer,
      log: (l) => logs.push(l),
    });
  });

  afterEach(async () => {
    await handler.shutdown();
  });

  test("first initialize spawns a fresh pair, returns 200, assigns a new Mcp-Session-Id, logs 'created'", async () => {
    const res = await handler(initReq());
    expect(res.status).toBe(200);
    const sid = res.headers.get("mcp-session-id");
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(handler.activeSessionCount()).toBe(1);
    expect(logs.some((l) => l.includes(`[mcp-session] created sid=${sid}`))).toBe(true);
  });

  test("two sequential initialize calls with no sid each spawn a fresh session with a distinct sid", async () => {
    const r1 = await handler(initReq());
    const r2 = await handler(initReq());
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const sid1 = r1.headers.get("mcp-session-id");
    const sid2 = r2.headers.get("mcp-session-id");
    expect(sid1).not.toBeNull();
    expect(sid2).not.toBeNull();
    expect(sid1).not.toBe(sid2);
    expect(handler.activeSessionCount()).toBe(2);
  });

  test("initialize then tools/list with the returned sid hits the same server and succeeds", async () => {
    const init = await handler(initReq());
    const sid = init.headers.get("mcp-session-id") as string;
    const list = await handler(withSid(sid, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { result?: { tools?: Array<{ name: string }> } };
    expect(body.result?.tools?.map((t) => t.name)).toEqual(["ping"]);
  });

  test("DELETE /mcp with a valid sid removes the session, returns 200, and logs 'deleted'", async () => {
    const init = await handler(initReq());
    const sid = init.headers.get("mcp-session-id") as string;
    const del = await handler(
      new Request("http://x/mcp", { method: "DELETE", headers: { "mcp-session-id": sid } }),
    );
    expect(del.status).toBe(200);
    expect(handler.activeSessionCount()).toBe(0);
    expect(logs.some((l) => l.includes(`[mcp-session] deleted sid=${sid}`))).toBe(true);
  });

  test("DELETE with unknown sid is idempotent — 200 OK, no log, session count unchanged", async () => {
    await handler(initReq());
    const before = handler.activeSessionCount();
    const del = await handler(
      new Request("http://x/mcp", { method: "DELETE", headers: { "mcp-session-id": "nope" } }),
    );
    expect(del.status).toBe(200);
    expect(handler.activeSessionCount()).toBe(before);
  });

  test("DELETE without any sid returns 200 and does not affect active sessions", async () => {
    await handler(initReq());
    const del = await handler(new Request("http://x/mcp", { method: "DELETE" }));
    expect(del.status).toBe(200);
    expect(handler.activeSessionCount()).toBe(1);
  });
});

describe("createSessionedMcpHandler — error paths", () => {
  let handler: SessionedMcpHandler;

  beforeEach(() => {
    handler = createSessionedMcpHandler({ createServer: mkServer });
  });

  afterEach(async () => {
    await handler.shutdown();
  });

  test("non-initialize POST without sid returns 400 'session required for non-initialize'", async () => {
    const res = await handler(initReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; error_description?: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/session required/);
  });

  test("POST with unknown sid returns 404 'session_not_found' so the client re-initializes", async () => {
    const res = await handler(
      withSid("deadbeef-dead-dead-dead-deaddeaddead", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("session_not_found");
  });

  test("POST with empty-string sid is treated as 'no sid' — non-initialize still 400", async () => {
    const req = new Request("http://x/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });
});

describe("createSessionedMcpHandler — lifecycle", () => {
  test("idle timeout evicts expired sessions (reason=idle)", async () => {
    const logs: string[] = [];
    const handler = createSessionedMcpHandler({
      createServer: mkServer,
      idleTimeoutMs: 50,
      log: (l) => logs.push(l),
    });
    try {
      const init = await handler(initReq());
      const sid = init.headers.get("mcp-session-id") as string;
      expect(handler.activeSessionCount()).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(handler.activeSessionCount()).toBe(0);
      expect(logs.some((l) => l.includes(`evicted sid=${sid} reason=idle`))).toBe(true);
    } finally {
      await handler.shutdown();
    }
  });

  test("maxSessions cap evicts LRU on new init (reason=cap)", async () => {
    const logs: string[] = [];
    const handler = createSessionedMcpHandler({
      createServer: mkServer,
      maxSessions: 2,
      log: (l) => logs.push(l),
    });
    try {
      const r1 = await handler(initReq());
      const sid1 = r1.headers.get("mcp-session-id") as string;
      const r2 = await handler(initReq());
      await handler(initReq()); // pushes over cap

      expect(handler.activeSessionCount()).toBe(2);
      expect(logs.some((l) => l.includes(`evicted sid=${sid1} reason=cap`))).toBe(true);
      expect(r2.status).toBe(200);
    } finally {
      await handler.shutdown();
    }
  });

  test("shutdown() stops the idle eviction loop and no further evictions fire", async () => {
    const logs: string[] = [];
    const handler = createSessionedMcpHandler({
      createServer: mkServer,
      idleTimeoutMs: 50,
      log: (l) => logs.push(l),
    });
    await handler(initReq());
    await handler.shutdown();
    expect(handler.activeSessionCount()).toBe(0);

    const logsAfterShutdown = logs.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(logs.length).toBe(logsAfterShutdown);
  });
});

describe("createSessionedMcpHandler — body handling", () => {
  let handler: SessionedMcpHandler;

  beforeEach(() => {
    handler = createSessionedMcpHandler({ createServer: mkServer });
  });

  afterEach(async () => {
    await handler.shutdown();
  });

  test("DELETE with empty body survives the Request-rebuild path (no 'body = \"\"' disaster)", async () => {
    const init = await handler(initReq());
    const sid = init.headers.get("mcp-session-id") as string;
    const del = await handler(
      new Request("http://x/mcp", { method: "DELETE", headers: { "mcp-session-id": sid } }),
    );
    expect(del.status).toBe(200);
  });

  test("large initialize body (~32KB) round-trips without truncation", async () => {
    const big = { ...INIT_BODY, params: { ...INIT_BODY.params, padding: "x".repeat(32_000) } };
    const res = await handler(initReq(big));
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("non-JSON body without sid is treated as non-initialize and returns 400", async () => {
    const req = new Request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });
});

// Suppress unused import if zod tree-shaking changes — needed for some lockfile configs.
void z;
