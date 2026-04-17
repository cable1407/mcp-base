# mcp-base

Shared TypeScript foundation for Model Context Protocol (MCP) servers.

## Purpose

One OAuth 2.0 + OIDC + consent + CORS + access-logging stack that every MCP server in the fleet consumes. Keeps the security-critical authorization surface in one place, gets any fix deployed to every server via a version bump instead of N copy-paste applications, and gives new MCP servers a 30-line starter instead of a 2000-line reimplementation.

## Non-goals

- Not a general-purpose HTTP framework — only what MCP servers need.
- Not a transport library — MCP protocol handling stays with each consumer's chosen MCP SDK. This base owns the HTTP perimeter, auth, and cross-cutting concerns around the `/mcp` endpoint; the MCP JSON-RPC behavior itself is delegated.
- Not a CLI tool. Consumers import and compose; there is no `mcp-base serve`.
- Not published to the public npm registry. Consumed as a git dependency (`"mcp-base": "github:cable1407/mcp-base#v0.3.0"`), tagged semver.

## Architecture

Each MCP server is a thin consumer:

```
┌────────────────────────────────────────┐
│  Consumer (e.g. cortex, second-brain)  │
│  • Tool definitions                    │
│  • Domain logic (index, filesystem…)   │
│  • Service-specific routes (push API)  │
│  • Startup wiring                      │
└──────────────┬─────────────────────────┘
               │ imports
               ▼
┌────────────────────────────────────────┐
│  mcp-base                              │
│  • OAuth (RFC 6749 + PKCE + 7591 DCR)  │
│  • RFC 9728 protected-resource meta    │
│  • RFC 8414 + OIDC discovery           │
│  • Consent form + password gate        │
│  • CORS + OPTIONS preflight            │
│  • Access logging (`[http]`)           │
│  • Base-path support (non-stripping)   │
│  • Unified dispatcher                  │
│  • FileOAuthStore + InMemoryStore      │
└────────────────────────────────────────┘
```

## Public API (targeted)

```ts
import { createMcpServer } from "mcp-base";

const server = await createMcpServer({
  // --- identity + wire ---
  name: "cortex",
  port: 3847,
  basePath: process.env.CORTEX_BASE_PATH,

  // --- auth ---
  oauth: {
    enabled: true,
    issuer: env.CORTEX_OAUTH_ISSUER,
    storePath: "/app/data/oauth.json",
    accessTokenTtlSec: 3600,
    authPassword: env.CORTEX_AUTH_PASSWORD,  // consent-form password
  },

  // --- observability ---
  accessLog: true,

  // --- service's MCP handler (caller supplies) ---
  mcpHandler: async (req) => { /* JSON-RPC */ },

  // --- optional extras ---
  extraRoutes: [
    { method: "POST", path: "/index",   handler: pushIndexHandler,   requireToken: env.CORTEX_PUSH_TOKEN },
    { method: "POST", path: "/reindex", handler: pushReindexHandler, requireToken: env.CORTEX_PUSH_TOKEN },
    { method: "GET",  path: "/health",  handler: healthHandler,      public: true },
  ],
});

server.listen();
```

Under the hood, `createMcpServer`:
1. Constructs the unified dispatcher in the right order: `withAccessLog → withCors → baseHandler(mcp, oauth, extra)`.
2. Registers OAuth routes (`/authorize`, `/token`, `/register`, `/.well-known/*`).
3. Installs auth middleware around `mcpHandler`.
4. Matches `extraRoutes` before falling through to 404.
5. Exposes `server.stop()` for graceful shutdown.

Everything else (OAuth stores, middlewares, base-path utilities) is available as named exports for consumers that need lower-level access.

### Named exports (partial list)

- `FileOAuthStore`, `InMemoryOAuthStore` — persistent + in-memory `OAuthStore` implementations
- `withCors`, `withAccessLog` — middleware if a consumer wants to build its own top-level handler
- `normalizeBasePath`, `stripBasePath` — path-prefix utilities
- `escapeHtml`, `timingSafeEqualStrings` — small helpers used across endpoints
- `createSessionedMcpHandler`, `createStatelessMcpHandler` — MCP HTTP handler factories (see below)
- Types: `OAuthConfig`, `ExtraRoute`, `McpServerConfig`, `Handler`

### MCP handler modes: sessioned vs stateless

Two factories produce the `mcpHandler` you pass into `createMcpServer`:

- **`createSessionedMcpHandler`** — owns one `(transport, McpServer)` per `Mcp-Session-Id`, with idle eviction + LRU cap. Use when tools keep server-side state between calls (subscriptions, long-lived channels, resource watches).

- **`createStatelessMcpHandler`** — spawns a fresh `(transport, McpServer)` per request, dispatches, closes. No session map, no eviction, no `session_not_found` ever. Use when every tool is a pure function of external state (filesystem, database, search index).

Pick stateless by default for read-mostly tool servers. The sessioned mode has a documented failure mode: clients that cache a session id across a server restart (or past the idle-eviction window) get wedged until they disconnect-and-reconnect — and some clients (notably claude.ai's MCP connector) don't auto-recover. Stateless mode sidesteps the whole category.

```ts
// Before (v0.2.x):
const mcpHandler = createSessionedMcpHandler({ createServer });
// After (v0.3.0+), for read-mostly servers:
const mcpHandler = createStatelessMcpHandler({ createServer });
```

Tradeoff: stateless pays a per-request allocation (`McpServer` + transport) that sessioned amortizes across a session's lifetime. Negligible for request volumes under ~1/sec; would matter past ~100/sec.

## Consumer contract

A consumer MUST provide:
- `name` — human-readable identifier (shows up in logs)
- `mcpHandler` — an async `(req) => Response` that implements JSON-RPC MCP. Wrapped by auth middleware automatically.

A consumer MAY provide:
- `oauth` config (omit to run unauthenticated, e.g., localhost-only deploys)
- `accessLog: false` to silence
- `basePath` for reverse-proxy deployments that preserve path prefixes (nginx without strip, etc.)
- `extraRoutes` for service-specific endpoints (push APIs, health dashboards, admin tools)

A consumer MUST NOT:
- Reimplement OAuth endpoints — the base owns them
- Skip the consent step when exposed publicly — `authPassword` is required when `oauth.enabled`
- Bypass CORS wrapping — prevents browser-based MCP clients from working

## Extension points

**Adding a new MCP server on top of the base:**
1. `npm init`, add `"mcp-base": "github:cable1407/mcp-base#vX.Y.Z"` as a dependency
2. Write your tool handlers and MCP JSON-RPC dispatcher
3. Wire via `createMcpServer({...})`
4. Dockerfile + docker-compose + README

**Customizing auth:** Consumer passes a full `AuthMiddleware` function instead of the default OAuth. Used for cases like cortex's push API (per-endpoint bearer token) that coexist with the main OAuth. Base allows both.

**Custom routes outside `/mcp`:** `extraRoutes` covers most cases. For deeper customization (streaming endpoints, WebSockets, file downloads), consumer can drop to `withCors + withAccessLog` around its own handler and build a fully custom stack. Base's utilities still apply.

## Versioning policy

- **Semver**, tagged as `vX.Y.Z` git tags for git-dependency consumption.
- **Breaking changes** bump major. Requires a migration note in the release body listing each consumer's required change.
- **New features** bump minor. Consumers can opt in when ready.
- **Bug fixes / security** bump patch. Consumers pull immediately via `bun update` or explicit tag bump.
- Each consumer's package.json pins a specific tag — no floating. Breakage visibility comes from intentional version bumps.

## Testing strategy

**Base repo:**
- Unit tests for every module (OAuth endpoints, middleware, access-log, CORS, base-path, stores)
- Integration tests that spin up a `createMcpServer({...})` with a stub `mcpHandler` and verify the full HTTP perimeter end-to-end (consent flow, DCR + PKCE + token, discovery docs, CORS preflight, access log output)
- Target: retain cortex's current 213-test baseline as the extraction moves modules over

**Consumer repos:**
- Integration tests that verify the wiring (e.g. "cortex's push-API extra route returns 401 without token, 200 with") but DON'T duplicate base's OAuth tests
- Tool-specific tests owned by the consumer (cortex's FTS5 coverage, second-brain's path-safety escape cases)

## Migration plan (summary)

1. **Phase 1 — Scaffold base** (#1): monorepo shape, tsconfig, build setup, CI
2. **Phase 2 — Extract from cortex** (#2): move modules, tag `v0.1.0`, cortex consumes; retain 213-test baseline
3. **Phase 3 — TypeScript rewrite of second-brain** (#3, in `cable1407/second-brain-mcp-server` feature branch): port tools, preserve path-safety semantics, add DCR + consent + CORS gain
4. **Phase 4 — Path-route second-brain** (#4): once base-path support is inherited, move second-brain behind `/second-brain` or similar, retire the root mount

Each phase is a separate issue in its native repo. Cross-cutting issues (API shape, breaking changes) live here.

## Future consumers

Any MCP server that benefits from the OAuth stack and access logging: agent-journal, code-index, email-index, calendar-mcp, whatever comes next. The base should make "new MCP server" a one-hour scaffolding job rather than a one-week reimplementation.

## Status

- [ ] Phase 1 scaffolding (#1)
- [ ] Phase 2 cortex migration (#2)
- [ ] Phase 3 second-brain rewrite (#3)
- [ ] Phase 4 path-route second-brain (#4)
