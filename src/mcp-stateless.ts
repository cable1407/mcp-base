import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export type Handler = (req: Request) => Promise<Response>;

export interface StatelessMcpHandlerConfig {
  /** Invoked once per request to produce a fresh McpServer. Must not retain
   * cross-request state — the server is closed immediately after the
   * response is produced. */
  readonly createServer: () => McpServer;
  /** Diagnostic log sink. Default: no-op. */
  readonly log?: ((line: string) => void) | undefined;
}

/** Stateless MCP HTTP handler. Each request spawns a fresh
 * `(transport, McpServer)` pair, dispatches, and closes. No session map, no
 * eviction, no idle timeout, no `session_not_found` ever.
 *
 * Routing:
 *   - DELETE                                  → 200 (no-op; nothing persistent to delete)
 *   - Any other method                        → spawn fresh pair, dispatch, close
 *
 * For tool servers where every tool is a pure function of external state
 * (e.g. a filesystem or a database), this is strictly simpler than
 * `createSessionedMcpHandler` and avoids the classic "client caches a sid,
 * server evicts or restarts, client gets wedged" failure mode that the
 * claude.ai MCP connector in particular does not recover from.
 *
 * Tradeoffs vs sessioned:
 *   - Pros: no map, no eviction bug, server restart is invisible to clients,
 *     no `initialize`-once constraint.
 *   - Cons: per-request allocation (transport + McpServer). Negligible for
 *     request volumes <1/sec; would matter for >100/sec (not our profile).
 *     Does not support stateful protocols (subscriptions). */
export function createStatelessMcpHandler(config: StatelessMcpHandlerConfig): Handler {
  const log = config.log ?? ((): void => undefined);
  return async (req: Request): Promise<Response> => {
    if (req.method === "DELETE") {
      return new Response(null, { status: 200 });
    }

    // Omitting sessionIdGenerator puts the SDK transport into stateless
    // mode — no Mcp-Session-Id is issued and every request is independent.
    // The SDK's internal checks treat "absent" and "undefined" identically,
    // but strict TS (`exactOptionalPropertyTypes`) rejects the explicit
    // `sessionIdGenerator: undefined` spelling, so we just leave it off.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const server = config.createServer();
    try {
      await server.connect(transport);
      return await transport.handleRequest(req);
    } finally {
      try {
        await server.close();
      } catch (err) {
        // Diagnostic only — the request is done either way and another
        // request will spawn its own server next.
        log(`[mcp-stateless] server close failed: ${String(err)}`);
      }
    }
  };
}
