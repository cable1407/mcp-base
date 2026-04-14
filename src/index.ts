/**
 * mcp-base — shared TypeScript foundation for Model Context Protocol servers.
 *
 * Two tiers of public API:
 *
 * 1. **Opinionated factory (most consumers):** `createMcpServer({...})` wires
 *    the full HTTP perimeter in the right order — access log → CORS →
 *    unified dispatcher (OAuth + /mcp + optional extra routes) → Bun.serve.
 *    OAuth + consent + discovery + CORS + logging are all handled; the
 *    consumer supplies `mcpHandler` and (optionally) `extraRoutes` for
 *    service-specific endpoints.
 *
 * 2. **Lower-level primitives (consumers that need custom stacks):** the
 *    middlewares (`withAccessLog`, `withCors`), handler factories
 *    (`createOAuthHandler`, `authMiddleware`, `createUnifiedHandler`), stores
 *    (`FileOAuthStore`, `InMemoryOAuthStore`), path utilities, and HTML
 *    helpers are exported individually so consumers can compose their own
 *    top-level handler.
 *
 * Consumed as a git dependency (`"mcp-base": "github:cable1407/mcp-base#vX.Y.Z"`),
 * never published to npm. See the README for the full design.
 */

export { withAccessLog, type AccessLogConfig } from "./access-log.ts";
export { normalizeBasePath, stripBasePath } from "./base-path.ts";
export { withCors } from "./cors.ts";
export {
  createUnifiedHandler,
  type Handler,
  type UnifiedHandlerDeps,
} from "./dispatcher.ts";
export { escapeHtml, timingSafeEqualStrings } from "./html.ts";
export {
  OAUTH_PATHS,
  createOAuthHandler,
  type OAuthHandlerConfig,
} from "./oauth/endpoints.ts";
export {
  createSessionedMcpHandler,
  type SessionedMcpHandler,
  type SessionedMcpHandlerConfig,
} from "./mcp-session.ts";
export { FileOAuthStore } from "./oauth/file-store.ts";
export { authMiddleware, type AuthMiddlewareConfig } from "./oauth/middleware.ts";
export { verifyPkce, type VerifyPkceArgs } from "./oauth/pkce.ts";
export { InMemoryOAuthStore } from "./oauth/store.ts";
export type {
  AccessToken,
  AuthorizationCode,
  CodeChallengeMethod,
  OAuthClient,
  OAuthStore,
  RefreshToken,
} from "./oauth/types.ts";
export {
  createMcpServer,
  type ExtraRoute,
  type McpServer,
  type McpServerConfig,
  type OAuthConfig,
} from "./server.ts";
