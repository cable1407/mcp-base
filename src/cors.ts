type Handler = (req: Request) => Promise<Response>;

const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const ALLOW_HEADERS = "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version";
const EXPOSE_HEADERS = "Mcp-Session-Id, WWW-Authenticate";
const MAX_AGE = "86400";

export function withCors(inner: Handler): Handler {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": ALLOW_METHODS,
          "access-control-allow-headers": ALLOW_HEADERS,
          "access-control-expose-headers": EXPOSE_HEADERS,
          "access-control-max-age": MAX_AGE,
        },
      });
    }
    const res = await inner(req);
    const headers = new Headers(res.headers);
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-expose-headers", EXPOSE_HEADERS);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}
