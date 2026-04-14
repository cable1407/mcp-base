import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export type Handler = (req: Request) => Promise<Response>;

export interface SessionedMcpHandlerConfig {
  /** Invoked once per new session. Must return a fresh, unconnected McpServer. */
  readonly createServer: () => McpServer;
  /** Idle session eviction timeout. Default: 1 hour. */
  readonly idleTimeoutMs?: number | undefined;
  /** Concurrent-session cap. When exceeded, the LRU session is evicted. Default: 256. */
  readonly maxSessions?: number | undefined;
  /** Diagnostic log sink. Default: console.log. */
  readonly log?: ((line: string) => void) | undefined;
}

export interface SessionedMcpHandler {
  (req: Request): Promise<Response>;
  /** Current number of live sessions. Exposed for tests + health checks. */
  activeSessionCount(): number;
  /** Stops background eviction + closes every live session. Call on shutdown. */
  shutdown(): Promise<void>;
}

interface SessionEntry {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: McpServer;
  lastUsed: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 256;

/** Session-aware MCP HTTP handler. Owns one (transport, McpServer) pair per
 * Mcp-Session-Id so initialize is only ever called once per server instance.
 *
 * Routing:
 *   - No sid + JSON-RPC method="initialize"  → spawn fresh pair, dispatch,
 *                                              capture sid from the response,
 *                                              store in the session map
 *   - No sid + any other method              → 400 invalid_request
 *   - Matching sid + any method              → dispatch to existing pair,
 *                                              refresh lastUsed
 *   - Unknown sid + any method               → 404 session_not_found
 *   - DELETE (with or without sid)           → idempotent close + map delete
 *
 * Eviction: an idle session (lastUsed older than idleTimeoutMs) is closed and
 * removed by a background interval. When maxSessions is hit on a new init,
 * the LRU session is evicted synchronously. */
export function createSessionedMcpHandler(config: SessionedMcpHandlerConfig): SessionedMcpHandler {
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const log = config.log ?? ((line: string) => console.log(line));
  const sessions = new Map<string, SessionEntry>();

  const closeEntry = async (entry: SessionEntry): Promise<void> => {
    try {
      await entry.server.close();
    } catch {
      // SDK close errors are diagnostic noise — the session is gone either way.
    }
  };

  const evictIdle = async (): Promise<void> => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      if (now - entry.lastUsed > idleTimeoutMs) {
        sessions.delete(sid);
        await closeEntry(entry);
        log(`[mcp-session] evicted sid=${sid} reason=idle active=${sessions.size}`);
      }
    }
  };

  // Check 4x per idle window, clamped to [100ms, 60s]. Keeps tests responsive
  // (idleTimeoutMs=50 → check every ~100ms) without hot-looping in production.
  const checkInterval = Math.min(60_000, Math.max(100, Math.floor(idleTimeoutMs / 4)));
  let intervalId: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    void evictIdle();
  }, checkInterval);

  const evictLruForCap = async (): Promise<void> => {
    if (sessions.size < maxSessions) return;
    let oldestSid: string | undefined;
    let oldestUsed = Number.POSITIVE_INFINITY;
    for (const [sid, entry] of sessions) {
      if (entry.lastUsed < oldestUsed) {
        oldestUsed = entry.lastUsed;
        oldestSid = sid;
      }
    }
    if (oldestSid === undefined) return;
    const entry = sessions.get(oldestSid);
    sessions.delete(oldestSid);
    if (entry !== undefined) await closeEntry(entry);
    log(`[mcp-session] evicted sid=${oldestSid} reason=cap active=${sessions.size}`);
  };

  const handler = async (req: Request): Promise<Response> => {
    const rawSid = req.headers.get("mcp-session-id");
    const sid = rawSid !== null && rawSid !== "" ? rawSid : null;

    if (req.method === "DELETE") {
      if (sid !== null) {
        const entry = sessions.get(sid);
        if (entry !== undefined) {
          sessions.delete(sid);
          await closeEntry(entry);
          log(`[mcp-session] deleted sid=${sid} active=${sessions.size}`);
        }
      }
      return new Response(null, { status: 200 });
    }

    if (sid !== null) {
      const entry = sessions.get(sid);
      if (entry === undefined) {
        return jsonResponse(404, { error: "session_not_found" });
      }
      entry.lastUsed = Date.now();
      return entry.transport.handleRequest(req);
    }

    // No session id — only initialize requests are valid.
    const bodyText = await req.text();
    let isInitialize = false;
    try {
      const parsed = JSON.parse(bodyText) as { method?: unknown };
      isInitialize = parsed.method === "initialize";
    } catch {
      // body is not JSON → not an initialize request
    }

    if (!isInitialize) {
      return jsonResponse(400, {
        error: "invalid_request",
        error_description: "session required for non-initialize requests",
      });
    }

    await evictLruForCap();

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    const server = config.createServer();
    await server.connect(transport);

    const rebuilt = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: bodyText === "" ? undefined : bodyText,
    });
    const res = await transport.handleRequest(rebuilt);
    const newSid = res.headers.get("mcp-session-id");
    if (newSid !== null && newSid !== "") {
      sessions.set(newSid, { transport, server, lastUsed: Date.now() });
      log(`[mcp-session] created sid=${newSid} active=${sessions.size}`);
    } else {
      // SDK chose not to create a session (e.g. sessionIdGenerator returned
      // empty or the init failed). Don't leak the pair.
      await closeEntry({ transport, server, lastUsed: Date.now() });
    }
    return res;
  };

  const wrapper = Object.assign(handler, {
    activeSessionCount: (): number => sessions.size,
    shutdown: async (): Promise<void> => {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
      const entries = Array.from(sessions.values());
      sessions.clear();
      for (const entry of entries) {
        await closeEntry(entry);
      }
    },
  });
  return wrapper as SessionedMcpHandler;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
