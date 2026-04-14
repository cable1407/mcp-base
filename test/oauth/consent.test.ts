import { beforeEach, describe, expect, test } from "bun:test";
import { createOAuthHandler } from "../../src/oauth/endpoints.ts";
import { InMemoryOAuthStore } from "../../src/oauth/store.ts";

const CLIENT_ID = "c1";
const REDIRECT_URI = "https://claude.ai/cb";
const ISSUER = "http://localhost:3847";
const PASSWORD = "correct-horse-battery-staple";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

interface MakeEnvOptions {
  authPassword?: string | undefined;
}

const makeEnv = (opts: MakeEnvOptions = { authPassword: PASSWORD }) => {
  const store = new InMemoryOAuthStore();
  store.registerClient({ clientId: CLIENT_ID, redirectUris: [REDIRECT_URI] });
  const handler = createOAuthHandler({
    store,
    issuer: ISSUER,
    accessTokenTtlSec: 3600,
    authPassword: opts.authPassword,
  });
  return { store, handler };
};

const authorizeUrl = (): URL => {
  const url = new URL(`${ISSUER}/authorize`);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", CHALLENGE);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "xyz");
  return url;
};

describe("GET /authorize (consent page)", () => {
  let handler: (r: Request) => Promise<Response>;
  beforeEach(() => {
    handler = makeEnv().handler;
  });

  test("renders an HTML form (200) for valid params instead of auto-issuing a code", async () => {
    const res = await handler(new Request(authorizeUrl().toString()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html.toLowerCase()).toContain("<form");
    expect(html.toLowerCase()).toContain('method="post"');
    expect(html.toLowerCase()).toContain('name="password"');
    expect(html.toLowerCase()).toContain('type="password"');
  });

  test("form's action target POSTs back to /authorize with the query string preserved", async () => {
    const res = await handler(new Request(authorizeUrl().toString()));
    const html = await res.text();
    // The action URL must include at least client_id, redirect_uri, code_challenge
    // so POST handler can re-validate.
    expect(html).toContain(`client_id=${CLIENT_ID}`);
    expect(html).toContain("code_challenge=");
    expect(html).toContain("/authorize");
  });

  test("validation still runs first — unknown client_id returns 400 (no form rendered)", async () => {
    const url = authorizeUrl();
    url.searchParams.set("client_id", "nope");
    const res = await handler(new Request(url.toString()));
    expect(res.status).toBe(400);
  });

  test("validation still runs first — missing code_challenge returns 400", async () => {
    const url = authorizeUrl();
    url.searchParams.delete("code_challenge");
    const res = await handler(new Request(url.toString()));
    expect(res.status).toBe(400);
  });
});

describe("POST /authorize (password verification)", () => {
  let handler: (r: Request) => Promise<Response>;
  beforeEach(() => {
    handler = makeEnv().handler;
  });

  const postAuthorize = (password: string | null): Promise<Response> => {
    const body = new URLSearchParams();
    if (password !== null) body.set("password", password);
    return handler(
      new Request(authorizeUrl().toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
  };

  test("correct password issues an auth code and 302s to redirect_uri (state preserved)", async () => {
    const res = await postAuthorize(PASSWORD);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location");
    expect(loc).not.toBeNull();
    const redirect = new URL(loc as string);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get("state")).toBe("xyz");
    expect(redirect.searchParams.get("code")).not.toBeNull();
  });

  test("wrong password re-renders the form with an error and does NOT issue a code", async () => {
    const res = await postAuthorize("wrong");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html.toLowerCase()).toContain("invalid password");
    expect(html.toLowerCase()).toContain("<form");
    expect(res.headers.get("location")).toBeNull();
  });

  test("missing password field returns 400 invalid_request", async () => {
    const res = await postAuthorize(null);
    expect(res.status).toBe(400);
  });

  test("empty password returns 400 invalid_request (treated as missing)", async () => {
    const res = await postAuthorize("");
    expect(res.status).toBe(400);
  });

  test("timing-safe: correct password of different length than configured still fails cleanly (no crash)", async () => {
    const longAttempt = "x".repeat(500);
    const res = await postAuthorize(longAttempt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("invalid password");
  });

  test("validation still runs — unknown client_id returns 400 even with correct password", async () => {
    const url = authorizeUrl();
    url.searchParams.set("client_id", "nope");
    const body = new URLSearchParams();
    body.set("password", PASSWORD);
    const res = await handler(
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("consent form action URL is issuer-rooted (not host-relative)", () => {
  test("prefixed issuer produces an action like 'https://host/cortex/authorize?...' so POST reaches the server under a path prefix (fix for #37)", async () => {
    const prefixedIssuer = "https://host.example/cortex";
    const store = new InMemoryOAuthStore();
    store.registerClient({ clientId: CLIENT_ID, redirectUris: [REDIRECT_URI] });
    const handler = createOAuthHandler({
      store,
      issuer: prefixedIssuer,
      accessTokenTtlSec: 3600,
      authPassword: PASSWORD,
    });
    const res = await handler(new Request(authorizeUrl().toString()));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="${prefixedIssuer}/authorize?`);
    // Negative: no root-anchored '/authorize?' form target in the HTML.
    expect(html).not.toContain('action="/authorize?');
  });

  test("non-prefixed issuer still produces a fully-qualified action URL", async () => {
    const { handler } = makeEnv();
    const res = await handler(new Request(authorizeUrl().toString()));
    const html = await res.text();
    expect(html).toContain(`action="${ISSUER}/authorize?`);
  });

  test("issuer and query string are HTML-entity-escaped in the action attribute (defense-in-depth)", async () => {
    // Construct an issuer with characters that would break out of the action
    // attribute if not escaped. This is pathological (operators wouldn't set
    // one like this in practice) but pins the escaping contract.
    const hostile = 'https://host"><script>alert(1)</script>x.example/cortex';
    const store = new InMemoryOAuthStore();
    store.registerClient({ clientId: CLIENT_ID, redirectUris: [REDIRECT_URI] });
    const handler = createOAuthHandler({
      store,
      issuer: hostile,
      accessTokenTtlSec: 3600,
      authPassword: PASSWORD,
    });
    const res = await handler(new Request(authorizeUrl().toString()));
    const html = await res.text();
    // Raw attacker chars must NOT appear anywhere — they'd break out of the
    // attribute and inject a <script> tag.
    expect(html).not.toContain('"><script>');
    // The escaped form MUST be present inside the action attribute.
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    // Query-string '&' between params must be escaped to '&amp;' inside
    // the attribute so the HTML parser doesn't misinterpret them.
    expect(html).toMatch(/action="[^"]*client_id=[^"]*&amp;[^"]*"/);
  });
});

describe("/authorize with no CORTEX_AUTH_PASSWORD configured", () => {
  test("GET returns 503 (fail-closed) when authPassword is unset", async () => {
    const { handler } = makeEnv({ authPassword: undefined });
    const res = await handler(new Request(authorizeUrl().toString()));
    expect(res.status).toBe(503);
  });

  test("POST returns 503 when authPassword is unset", async () => {
    const { handler } = makeEnv({ authPassword: undefined });
    const res = await handler(
      new Request(authorizeUrl().toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "password=anything",
      }),
    );
    expect(res.status).toBe(503);
  });

  test("empty-string authPassword is treated as unset (503)", async () => {
    const { handler } = makeEnv({ authPassword: "" });
    const res = await handler(new Request(authorizeUrl().toString()));
    expect(res.status).toBe(503);
  });
});
