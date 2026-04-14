import { withAccessLog } from "./access-log.ts";
import { normalizeBasePath } from "./base-path.ts";
import { withCors } from "./cors.ts";
import { type Handler, type UnifiedHandlerDeps, createUnifiedHandler } from "./dispatcher.ts";
import { timingSafeEqualStrings } from "./html.ts";
import { createOAuthHandler } from "./oauth/endpoints.ts";
import { FileOAuthStore } from "./oauth/file-store.ts";
import { authMiddleware } from "./oauth/middleware.ts";

export interface OAuthConfig {
  readonly enabled: boolean;
  readonly issuer: string;
  readonly storePath: string;
  readonly accessTokenTtlSec: number;
  readonly authPassword: string;
  readonly clientId?: string | undefined;
  readonly redirectUris?: readonly string[] | undefined;
}

export interface ExtraRoute {
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  readonly path: string;
  readonly handler: Handler;
  readonly requireToken?: string | undefined;
  readonly public?: boolean | undefined;
}

export interface McpServerConfig {
  readonly name: string;
  readonly port: number;
  readonly basePath?: string | undefined;
  readonly oauth?: OAuthConfig | undefined;
  readonly accessLog?: boolean | undefined;
  readonly mcpHandler: Handler;
  readonly extraRoutes?: readonly ExtraRoute[] | undefined;
}

export interface McpServer {
  listen(): void;
  stop(): Promise<void>;
  readonly port: number;
}

export async function createMcpServer(config: McpServerConfig): Promise<McpServer> {
  const basePath = normalizeBasePath(config.basePath);

  let oauthHandler: Handler | undefined;
  let authMw: ((inner: Handler) => Handler) | undefined;
  if (config.oauth?.enabled) {
    const o = config.oauth;
    if (!o.authPassword) {
      throw new Error(
        "mcp-base: oauth.enabled requires authPassword — without it /authorize would issue codes without consent",
      );
    }
    const store = new FileOAuthStore(o.storePath);
    if (o.clientId !== undefined && o.redirectUris !== undefined && o.redirectUris.length > 0) {
      store.registerClient({ clientId: o.clientId, redirectUris: o.redirectUris });
    }
    oauthHandler = createOAuthHandler({
      store,
      issuer: o.issuer,
      accessTokenTtlSec: o.accessTokenTtlSec,
      authPassword: o.authPassword,
    });
    authMw = authMiddleware({ store, issuer: o.issuer });
  }

  const extras = config.extraRoutes ?? [];
  const extraHandler: Handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const match = extras.find((r) => r.path === url.pathname && r.method === req.method);
    if (!match) return notFound();
    const requiresToken = match.public !== true && match.requireToken !== undefined;
    if (requiresToken) {
      const token = match.requireToken as string;
      if (!checkBearer(req, token)) return unauthorizedBearer(config.name);
    }
    return match.handler(req);
  };

  const deps: UnifiedHandlerDeps = {
    mcp: config.mcpHandler,
    push: extraHandler,
  };
  if (oauthHandler !== undefined) deps.oauth = oauthHandler;
  if (authMw !== undefined) deps.authMiddleware = authMw;
  if (basePath !== "") deps.basePath = basePath;

  const handler = withAccessLog(
    { enabled: config.accessLog ?? true },
    withCors(createUnifiedHandler(deps)),
  );

  let server: ReturnType<typeof Bun.serve> | undefined;
  return {
    listen() {
      server = Bun.serve({ port: config.port, fetch: handler });
      const rootUrl = `http://${server.hostname}:${server.port}${basePath}`;
      console.log(`${config.name}: ${rootUrl}`);
    },
    async stop(): Promise<void> {
      if (server) {
        await server.stop();
        server = undefined;
      }
    },
    get port(): number {
      return server?.port ?? config.port;
    },
  };
}

function checkBearer(req: Request, expected: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  // Empty or malformed tokens (e.g. bare "Bearer" with nothing after) yield
  // an empty `provided` string — fails the length check in
  // timingSafeEqualStrings below and returns false safely.
  const provided = header.slice(7).trim();
  return timingSafeEqualStrings(provided, expected);
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function unauthorizedBearer(realm: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer realm="${realm}"`,
    },
  });
}
