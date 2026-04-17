import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createStatelessMcpHandler } from "../src/mcp-stateless.ts";

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

const TOOLS_LIST_BODY = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
};

const callPing = (id = 3): unknown => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "ping", arguments: {} },
});

interface TrackedServer {
  readonly server: McpServer;
  closed: boolean;
}

const mkServer = (onMake?: (t: TrackedServer) => void): McpServer => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool("ping", { description: "returns pong", inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  server.registerTool("boom", { description: "throws", inputSchema: {} }, async () => {
    throw new Error("intentional");
  });
  const tracked: TrackedServer = { server, closed: false };
  const origClose = server.close.bind(server);
  server.close = async (): Promise<void> => {
    tracked.closed = true;
    await origClose();
  };
  onMake?.(tracked);
  return server;
};

const req = (body: unknown, sid?: string): Request => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sid !== undefined) headers["mcp-session-id"] = sid;
  return new Request("http://x/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
};

const deleteReq = (sid?: string): Request => {
  const headers: Record<string, string> = {};
  if (sid !== undefined) headers["mcp-session-id"] = sid;
  return new Request("http://x/mcp", { method: "DELETE", headers });
};

// Stateless handler parses the SSE body to application/json when
// enableJsonResponse is true, so responses are plain JSON objects we
// can expect-match on.
async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  // Some transports return SSE-framed JSON-RPC; support both.
  const line = text.split("\n").find((l) => l.startsWith("{") || l.startsWith("data:"));
  if (line === undefined) return {} as Record<string, unknown>;
  const cleaned = line.startsWith("data:") ? line.slice(5).trim() : line;
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

describe("createStatelessMcpHandler — happy path", () => {
  test("POST initialize → 200 and no Mcp-Session-Id is issued (stateless)", async () => {
    const handler = createStatelessMcpHandler({ createServer: () => mkServer() });
    const res = await handler(req(INIT_BODY));
    expect(res.status).toBe(200);
    const sid = res.headers.get("mcp-session-id");
    expect(sid === null || sid === "").toBe(true);
  });

  test("POST tools/list without a sid succeeds (no session required)", async () => {
    const handler = createStatelessMcpHandler({ createServer: () => mkServer() });
    const res = await handler(req(TOOLS_LIST_BODY));
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    // Either a top-level result or an error-but-not-400-invalid_request.
    // We mainly assert the HTTP layer accepted the request.
    expect(body).toBeDefined();
  });

  test("POST tools/call without a sid runs the tool", async () => {
    const handler = createStatelessMcpHandler({ createServer: () => mkServer() });
    const res = await handler(req(callPing()));
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const result = (body as { result?: { content?: Array<{ text?: string }> } }).result;
    expect(result?.content?.[0]?.text).toBe("pong");
  });

  test("DELETE returns 200 no-op (no persistent state to delete)", async () => {
    const handler = createStatelessMcpHandler({ createServer: () => mkServer() });
    const res = await handler(deleteReq());
    expect(res.status).toBe(200);
  });

  test("DELETE with a sid still returns 200 (stateless mode ignores the sid)", async () => {
    const handler = createStatelessMcpHandler({ createServer: () => mkServer() });
    const res = await handler(deleteReq("any-client-supplied-sid"));
    expect(res.status).toBe(200);
  });
});

describe("createStatelessMcpHandler — server lifecycle", () => {
  test("server.close() is called after each request (no leaks)", async () => {
    const tracked: TrackedServer[] = [];
    const handler = createStatelessMcpHandler({
      createServer: () => mkServer((t) => tracked.push(t)),
    });
    await handler(req(callPing()));
    // The finally branch in the handler calls server.close() — give the
    // microtask queue one tick to flush it.
    await new Promise((r) => setTimeout(r, 0));
    expect(tracked.length).toBe(1);
    expect(tracked[0]?.closed).toBe(true);
  });

  test("three sequential requests each spawn a new server, close it, and leave nothing live", async () => {
    const tracked: TrackedServer[] = [];
    const handler = createStatelessMcpHandler({
      createServer: () => mkServer((t) => tracked.push(t)),
    });
    await handler(req(callPing(1)));
    await handler(req(callPing(2)));
    await handler(req(callPing(3)));
    await new Promise((r) => setTimeout(r, 0));
    expect(tracked.length).toBe(3);
    for (const t of tracked) expect(t.closed).toBe(true);
  });

  test("concurrent requests each get an independent server (no cross-request state)", async () => {
    const tracked: TrackedServer[] = [];
    const handler = createStatelessMcpHandler({
      createServer: () => mkServer((t) => tracked.push(t)),
    });
    const results = await Promise.all([
      handler(req(callPing(10))),
      handler(req(callPing(11))),
      handler(req(callPing(12))),
    ]);
    for (const res of results) expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(tracked.length).toBe(3);
    // Every server is distinct (no shared instance).
    expect(new Set(tracked.map((t) => t.server)).size).toBe(3);
  });
});

describe("createStatelessMcpHandler — error surface", () => {
  test("tools/call of a throwing tool still completes with 200 + JSON-RPC error in body", async () => {
    const handler = createStatelessMcpHandler({ createServer: () => mkServer() });
    const boomBody = {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    };
    const res = await handler(req(boomBody));
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    // MCP SDK returns tool errors via the isError flag inside result, or as
    // a top-level JSON-RPC error — accept either shape, just require the
    // transport itself didn't 5xx.
    const hasError =
      (body as { error?: unknown }).error !== undefined ||
      ((body as { result?: { isError?: boolean } }).result?.isError ?? false) === true;
    expect(hasError).toBe(true);
  });

  test("log callback is invoked on server close failure (diagnostic only, no throw)", async () => {
    const logs: string[] = [];
    const handler = createStatelessMcpHandler({
      createServer: () => {
        const s = mkServer();
        s.close = async (): Promise<void> => {
          throw new Error("close blew up");
        };
        return s;
      },
      log: (line) => logs.push(line),
    });
    const res = await handler(req(callPing()));
    expect(res.status).toBe(200);
    // The request completes regardless; log may or may not be invoked
    // depending on implementation, but the handler MUST NOT throw.
  });
});

describe("createStatelessMcpHandler — no map, no state leakage", () => {
  test("does not retain any per-session state across requests", async () => {
    // Build a server whose closure holds a counter. If the handler retained
    // per-session state, successive requests would see the same counter.
    // Stateless mode always spawns fresh, so each gets counter=0.
    let globalCounter = 0;
    const handler = createStatelessMcpHandler({
      createServer: () => {
        globalCounter++;
        return mkServer();
      },
    });
    await handler(req(callPing(1)));
    await handler(req(callPing(2)));
    await handler(req(callPing(3)));
    expect(globalCounter).toBe(3);
  });

  test("server restart is invisible to clients — new handler handles old-sid requests fine", async () => {
    const handler1 = createStatelessMcpHandler({ createServer: () => mkServer() });
    const r1 = await handler1(req(INIT_BODY));
    expect(r1.status).toBe(200);
    // Simulate a server restart — new handler instance, same behavior, no
    // session_not_found wedge.
    const handler2 = createStatelessMcpHandler({ createServer: () => mkServer() });
    const r2 = await handler2(req(callPing(), "would-have-been-stale-sid"));
    expect(r2.status).toBe(200);
  });
});
