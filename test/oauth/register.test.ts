import { beforeEach, describe, expect, test } from "bun:test";
import { OAUTH_PATHS, createOAuthHandler } from "../../src/oauth/endpoints.ts";
import { InMemoryOAuthStore } from "../../src/oauth/store.ts";

const ISSUER = "http://localhost:3847";

const AUTH_PASSWORD = "test-password";

const makeEnv = () => {
  const store = new InMemoryOAuthStore();
  const handler = createOAuthHandler({
    store,
    issuer: ISSUER,
    accessTokenTtlSec: 3600,
    authPassword: AUTH_PASSWORD,
  });
  return { store, handler };
};

const register = async (
  handler: (r: Request) => Promise<Response>,
  body: unknown,
): Promise<Response> => {
  return handler(
    new Request(`${ISSUER}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
};

describe("POST /register (RFC 7591 Dynamic Client Registration)", () => {
  let handler: (r: Request) => Promise<Response>;
  let store: InMemoryOAuthStore;

  beforeEach(() => {
    const env = makeEnv();
    handler = env.handler;
    store = env.store;
  });

  test("valid registration returns 201 with a generated client_id and echoed metadata", async () => {
    const res = await register(handler, {
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "claude.ai",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      client_id: string;
      redirect_uris: string[];
      client_name: string;
      token_endpoint_auth_method: string;
      grant_types: string[];
      response_types: string[];
      client_id_issued_at: number;
    };
    expect(typeof body.client_id).toBe("string");
    expect(body.client_id.length).toBeGreaterThan(0);
    expect(body.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(body.client_name).toBe("claude.ai");
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.response_types).toEqual(["code"]);
    expect(typeof body.client_id_issued_at).toBe("number");
  });

  test("the generated client_id is persisted and round-trips via findClient", async () => {
    const res = await register(handler, {
      redirect_uris: ["https://x/cb"],
      client_name: "x",
      token_endpoint_auth_method: "none",
    });
    const body = (await res.json()) as { client_id: string };
    const stored = store.findClient(body.client_id);
    expect(stored).not.toBeNull();
    expect(stored?.redirectUris).toEqual(["https://x/cb"]);
  });

  test("missing redirect_uris returns 400 invalid_client_metadata", async () => {
    const res = await register(handler, {
      client_name: "x",
      token_endpoint_auth_method: "none",
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: string };
    expect(err.error).toBe("invalid_client_metadata");
  });

  test("empty redirect_uris array returns 400", async () => {
    const res = await register(handler, {
      redirect_uris: [],
      client_name: "x",
      token_endpoint_auth_method: "none",
    });
    expect(res.status).toBe(400);
  });

  test("non-HTTPS redirect URI (other than localhost/127.0.0.1) returns 400", async () => {
    const res = await register(handler, {
      redirect_uris: ["http://evil.example/cb"],
      client_name: "x",
      token_endpoint_auth_method: "none",
    });
    expect(res.status).toBe(400);
  });

  test("http://localhost and http://127.0.0.1 redirect URIs are accepted", async () => {
    const r1 = await register(handler, {
      redirect_uris: ["http://localhost:3000/cb"],
      client_name: "dev",
      token_endpoint_auth_method: "none",
    });
    expect(r1.status).toBe(201);
    const r2 = await register(handler, {
      redirect_uris: ["http://127.0.0.1:3000/cb"],
      client_name: "dev2",
      token_endpoint_auth_method: "none",
    });
    expect(r2.status).toBe(201);
  });

  test("redirect URI with fragment returns 400", async () => {
    const res = await register(handler, {
      redirect_uris: ["https://x/cb#frag"],
      client_name: "x",
      token_endpoint_auth_method: "none",
    });
    expect(res.status).toBe(400);
  });

  test("unsupported token_endpoint_auth_method (e.g. client_secret_basic) returns 400", async () => {
    const res = await register(handler, {
      redirect_uris: ["https://x/cb"],
      client_name: "x",
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(res.status).toBe(400);
  });

  test("unsupported grant_types (e.g. password) returns 400", async () => {
    const res = await register(handler, {
      redirect_uris: ["https://x/cb"],
      client_name: "x",
      token_endpoint_auth_method: "none",
      grant_types: ["password"],
    });
    expect(res.status).toBe(400);
  });

  test("unsupported response_types (e.g. token) returns 400", async () => {
    const res = await register(handler, {
      redirect_uris: ["https://x/cb"],
      client_name: "x",
      token_endpoint_auth_method: "none",
      response_types: ["token"],
    });
    expect(res.status).toBe(400);
  });

  test("client_name longer than 256 chars returns 400", async () => {
    const res = await register(handler, {
      redirect_uris: ["https://x/cb"],
      client_name: "x".repeat(257),
      token_endpoint_auth_method: "none",
    });
    expect(res.status).toBe(400);
  });

  test("malformed JSON body returns 400", async () => {
    const res = await handler(
      new Request(`${ISSUER}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("GET /register returns 404 (registration is POST-only)", async () => {
    const res = await handler(new Request(`${ISSUER}/register`));
    expect(res.status).toBe(404);
  });

  test("registered client can complete the PKCE flow against /authorize + /token", async () => {
    const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

    const regRes = await register(handler, {
      redirect_uris: [REDIRECT],
      client_name: "claude.ai",
      token_endpoint_auth_method: "none",
    });
    const { client_id } = (await regRes.json()) as { client_id: string };

    const authUrl = new URL(`${ISSUER}/authorize`);
    authUrl.searchParams.set("client_id", client_id);
    authUrl.searchParams.set("redirect_uri", REDIRECT);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("code_challenge", CHALLENGE);
    authUrl.searchParams.set("code_challenge_method", "S256");
    const authBody = new URLSearchParams({ password: AUTH_PASSWORD });
    const authRes = await handler(
      new Request(authUrl.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: authBody.toString(),
      }),
    );
    expect(authRes.status).toBe(302);
    const code = new URL(authRes.headers.get("location") as string).searchParams.get("code");

    const tokBody = new URLSearchParams();
    tokBody.set("grant_type", "authorization_code");
    tokBody.set("code", code as string);
    tokBody.set("redirect_uri", REDIRECT);
    tokBody.set("client_id", client_id);
    tokBody.set("code_verifier", VERIFIER);
    const tokRes = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokBody.toString(),
      }),
    );
    expect(tokRes.status).toBe(200);
    const tokens = (await tokRes.json()) as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
  });
});

describe("discovery doc advertises registration_endpoint", () => {
  test("/.well-known/oauth-authorization-server includes registration_endpoint = <issuer>/register", async () => {
    const { handler } = makeEnv();
    const res = await handler(new Request(`${ISSUER}/.well-known/oauth-authorization-server`));
    const body = (await res.json()) as { registration_endpoint?: string };
    expect(body.registration_endpoint).toBe(`${ISSUER}/register`);
  });
});

describe("OAUTH_PATHS includes /register", () => {
  test("so createUnifiedHandler dispatches it to the OAuth handler", () => {
    expect(OAUTH_PATHS.has("/register")).toBe(true);
  });
});

describe("dynamically registered clients persist via FileOAuthStore", () => {
  test("a second FileOAuthStore instance over the same file finds the client after restart", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-reg-"));
    try {
      const { FileOAuthStore } = await import("../../src/oauth/file-store.ts");
      const store1 = new FileOAuthStore(path.join(tmp, "oauth.json"));
      const handler = createOAuthHandler({
        store: store1,
        issuer: ISSUER,
        accessTokenTtlSec: 3600,
        authPassword: AUTH_PASSWORD,
      });
      const res = await register(handler, {
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        client_name: "claude.ai",
        token_endpoint_auth_method: "none",
      });
      const { client_id } = (await res.json()) as { client_id: string };

      const store2 = new FileOAuthStore(path.join(tmp, "oauth.json"));
      const reloaded = store2.findClient(client_id);
      expect(reloaded).not.toBeNull();
      expect(reloaded?.redirectUris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
