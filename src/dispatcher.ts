import { stripBasePath } from "./base-path.ts";
import { OAUTH_PATHS } from "./oauth/endpoints.ts";

export type Handler = (req: Request) => Promise<Response>;

export interface UnifiedHandlerDeps {
  mcp: Handler;
  push: Handler;
  oauth?: Handler;
  authMiddleware?: (inner: Handler) => Handler;
  basePath?: string;
}

/** Top-level HTTP dispatcher. Routes requests by prefix-stripped path:
 *   /.well-known/* | /authorize | /token | /register → oauth
 *   /mcp (POST/DELETE)                               → mcp (via optional auth middleware)
 *   /mcp (GET)                                       → 405 Method Not Allowed
 *   anything else                                    → push (which typically does its own routing
 *                                                     over /health, /index, etc.)
 *   paths outside basePath                           → 404
 */
export function createUnifiedHandler(deps: UnifiedHandlerDeps): Handler {
  const mcpHandler = deps.authMiddleware ? deps.authMiddleware(deps.mcp) : deps.mcp;
  const oauth = deps.oauth;
  const basePath = deps.basePath ?? "";
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const stripped = stripBasePath(url.pathname, basePath);
    if (stripped === null) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const forwardedReq = basePath === "" ? req : rewritePath(req, url, stripped);
    if (oauth && OAUTH_PATHS.has(stripped)) return oauth(forwardedReq);
    if (stripped === "/mcp") {
      if (req.method === "GET") {
        return new Response("Streamable HTTP transport is POST-only", {
          status: 405,
          headers: { allow: "POST, DELETE, OPTIONS" },
        });
      }
      return mcpHandler(forwardedReq);
    }
    return deps.push(forwardedReq);
  };
}

function rewritePath(req: Request, url: URL, newPathname: string): Request {
  const rewritten = new URL(url.toString());
  rewritten.pathname = newPathname;
  return new Request(rewritten.toString(), req);
}
