import type { OAuthStore } from "./types.ts";

export interface AuthMiddlewareConfig {
  store: OAuthStore;
  issuer: string;
}

type Handler = (req: Request) => Promise<Response>;

export function authMiddleware(config: AuthMiddlewareConfig): (inner: Handler) => Handler {
  const resourceMetadata = `${config.issuer}/.well-known/oauth-protected-resource`;
  return (inner: Handler): Handler => {
    return async (req: Request): Promise<Response> => {
      const header = req.headers.get("authorization") ?? "";
      if (!header.toLowerCase().startsWith("bearer ")) {
        return unauthorized(resourceMetadata);
      }
      const token = header.slice(7).trim();
      if (token === "") return unauthorized(resourceMetadata);

      const entry = config.store.findAccessToken(token);
      if (!entry) return unauthorized(resourceMetadata, "invalid_token");
      if (entry.expiresAt < Date.now()) {
        return unauthorized(resourceMetadata, "invalid_token", "token expired");
      }
      return inner(req);
    };
  };
}

function unauthorized(resourceMetadata: string, error?: string, description?: string): Response {
  const parts = [`Bearer realm="cortex"`, `resource_metadata="${resourceMetadata}"`];
  if (error !== undefined) parts.push(`error="${error}"`);
  if (description !== undefined) parts.push(`error_description="${description}"`);
  return new Response(null, {
    status: 401,
    headers: { "www-authenticate": parts.join(", ") },
  });
}
