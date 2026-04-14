import { randomBytes } from "node:crypto";
import { escapeHtml, timingSafeEqualStrings } from "../html.ts";
import { verifyPkce } from "./pkce.ts";
import type { CodeChallengeMethod, OAuthStore } from "./types.ts";

export interface OAuthHandlerConfig {
  store: OAuthStore;
  issuer: string;
  accessTokenTtlSec: number;
  authCodeTtlSec?: number;
  /** Shared secret that gates the `/authorize` consent step. When unset or
   * empty, `/authorize` fails closed with 503 instead of silently issuing
   * codes. See issue #34. */
  authPassword?: string | undefined;
}

/** Route paths the OAuth handler owns. Exported so the unified handler can
 * dispatch without duplicating route strings. */
export const OAUTH_PATHS: ReadonlySet<string> = new Set([
  "/authorize",
  "/token",
  "/register",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/.well-known/oauth-protected-resource",
]);

export function createOAuthHandler(
  config: OAuthHandlerConfig,
): (req: Request) => Promise<Response> {
  const authCodeTtlMs = (config.authCodeTtlSec ?? 60) * 1000;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (
      (url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/openid-configuration") &&
      req.method === "GET"
    ) {
      return handleDiscovery(config.issuer);
    }

    if (url.pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
      return handleProtectedResourceMetadata(config.issuer);
    }

    if (url.pathname === "/authorize" && (req.method === "GET" || req.method === "POST")) {
      return handleAuthorize(req, url, config, authCodeTtlMs);
    }

    if (url.pathname === "/token" && req.method === "POST") {
      return handleToken(req, config);
    }

    if (url.pathname === "/register" && req.method === "POST") {
      return handleRegister(req, config);
    }

    return new Response(null, { status: 404 });
  };
}

function handleProtectedResourceMetadata(issuer: string): Response {
  return json({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  });
}

function handleDiscovery(issuer: string): Response {
  return json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

async function handleRegister(req: Request, config: OAuthHandlerConfig): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return errorResponse("invalid_client_metadata", "malformed JSON body", 400);
  }
  if (!parsed || typeof parsed !== "object") {
    return errorResponse("invalid_client_metadata", "request body must be a JSON object", 400);
  }
  const body = parsed as Record<string, unknown>;

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return errorResponse(
      "invalid_client_metadata",
      "redirect_uris is required and must be a non-empty array",
      400,
    );
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isValidRedirectUri(uri)) {
      return errorResponse("invalid_client_metadata", `invalid redirect_uri: ${uri}`, 400);
    }
  }

  const authMethod = body.token_endpoint_auth_method ?? "none";
  if (authMethod !== "none") {
    return errorResponse(
      "invalid_client_metadata",
      "only token_endpoint_auth_method='none' is supported (public PKCE clients)",
      400,
    );
  }

  const grantTypes = body.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grantTypes) || !grantTypes.every(isSupportedGrantType)) {
    return errorResponse(
      "invalid_client_metadata",
      "grant_types must only contain 'authorization_code' and/or 'refresh_token'",
      400,
    );
  }

  const responseTypes = body.response_types ?? ["code"];
  if (!Array.isArray(responseTypes) || !responseTypes.every((t) => t === "code")) {
    return errorResponse("invalid_client_metadata", "response_types must only contain 'code'", 400);
  }

  const clientName = body.client_name;
  if (clientName !== undefined && typeof clientName !== "string") {
    return errorResponse("invalid_client_metadata", "client_name must be a string", 400);
  }
  if (typeof clientName === "string" && clientName.length > 256) {
    return errorResponse("invalid_client_metadata", "client_name exceeds 256 characters", 400);
  }

  const clientId = randomBytes(16).toString("base64url");
  config.store.registerClient({
    clientId,
    redirectUris: redirectUris as readonly string[],
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const response: Record<string, unknown> = {
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: grantTypes,
    response_types: responseTypes,
    client_id_issued_at: issuedAt,
  };
  if (typeof clientName === "string") response.client_name = clientName;
  if (typeof body.scope === "string") response.scope = body.scope;
  return json(response, 201);
}

function isValidRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash !== "") return false;
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  }
  return false;
}

function isSupportedGrantType(gt: unknown): boolean {
  return gt === "authorization_code" || gt === "refresh_token";
}

interface ValidatedAuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: CodeChallengeMethod;
  state: string | null;
}

type AuthorizeValidation =
  | { kind: "ok"; params: ValidatedAuthorizeParams }
  | { kind: "error"; response: Response };

function validateAuthorizeParams(url: URL, store: OAuthStore): AuthorizeValidation {
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const responseType = url.searchParams.get("response_type");
  const codeChallenge = url.searchParams.get("code_challenge");
  const methodParam = url.searchParams.get("code_challenge_method") ?? "plain";
  const state = url.searchParams.get("state");

  if (clientId === null || redirectUri === null) {
    return {
      kind: "error",
      response: errorResponse("invalid_request", "client_id and redirect_uri required", 400),
    };
  }
  const client = store.findClient(clientId);
  if (!client) {
    return {
      kind: "error",
      response: errorResponse("invalid_client", "unknown client_id", 400),
    };
  }
  if (!client.redirectUris.includes(redirectUri)) {
    return {
      kind: "error",
      response: errorResponse("invalid_request", "redirect_uri not registered", 400),
    };
  }
  if (responseType !== "code") {
    return {
      kind: "error",
      response: errorResponse(
        "unsupported_response_type",
        "only response_type=code supported",
        400,
      ),
    };
  }
  if (codeChallenge === null) {
    return {
      kind: "error",
      response: errorResponse("invalid_request", "code_challenge required (PKCE)", 400),
    };
  }
  if (methodParam !== "S256" && methodParam !== "plain") {
    return {
      kind: "error",
      response: errorResponse("invalid_request", "unsupported code_challenge_method", 400),
    };
  }

  return {
    kind: "ok",
    params: {
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: methodParam,
      state,
    },
  };
}

async function handleAuthorize(
  req: Request,
  url: URL,
  config: OAuthHandlerConfig,
  authCodeTtlMs: number,
): Promise<Response> {
  if (config.authPassword === undefined || config.authPassword === "") {
    return new Response(
      JSON.stringify({
        error: "service_unavailable",
        error_description:
          "CORTEX_AUTH_PASSWORD is not configured — /authorize is disabled for safety",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  const validation = validateAuthorizeParams(url, config.store);
  if (validation.kind === "error") return validation.response;
  const params = validation.params;

  if (req.method === "GET") {
    return renderConsentForm(config.issuer, url, null);
  }

  // POST — verify password, issue code on match, re-render with error on mismatch.
  const form = await parseForm(req);
  if (form === null) {
    return errorResponse("invalid_request", "expected application/x-www-form-urlencoded", 400);
  }
  const password = form.get("password");
  if (password === null || password === "") {
    return errorResponse("invalid_request", "password required", 400);
  }
  if (!timingSafeEqualStrings(password, config.authPassword)) {
    return renderConsentForm(config.issuer, url, "Invalid password");
  }

  // Consent granted. Issue the code.
  const code = randomBytes(32).toString("base64url");
  config.store.putCode({
    code,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    expiresAt: Date.now() + authCodeTtlMs,
  });

  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set("code", code);
  if (params.state !== null) redirect.searchParams.set("state", params.state);
  return new Response(null, { status: 302, headers: { location: redirect.toString() } });
}

function renderConsentForm(issuer: string, url: URL, error: string | null): Response {
  // Preserve query string on POST action. Use the configured issuer as the
  // action base so prefixed deployments (e.g. Tailscale Funnel + CORTEX_BASE_PATH
  // scenarios where the prefix is in the issuer) route the POST correctly.
  // A root-anchored '/authorize' would 404 when fronted at a non-root path.
  // Both halves are escapeHtml'd as defense-in-depth: issuer is operator-
  // configured (not attacker-controllable today) and the query string is
  // URL-encoded, but attribute-context HTML escaping is still correct and
  // cheap — and '&' in the query needs to be '&amp;' inside an HTML attribute.
  const action = `${escapeHtml(issuer)}/authorize?${escapeHtml(url.searchParams.toString())}`;
  const errorHtml = error === null ? "" : `<p class="error">${escapeHtml(error)}</p>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cortex — authorize</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 360px; margin: 10vh auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.25rem; margin-bottom: 1.5rem; }
  label { display: block; margin-bottom: 0.5rem; font-size: 0.9rem; }
  input[type="password"] { width: 100%; padding: 0.6rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
  button { margin-top: 1rem; width: 100%; padding: 0.6rem; font-size: 1rem; background: #222; color: #fff; border: 0; border-radius: 4px; cursor: pointer; }
  button:hover { background: #000; }
  .error { color: #b00020; font-size: 0.9rem; margin-top: 0.75rem; }
  .note { color: #666; font-size: 0.8rem; margin-top: 1.5rem; }
</style>
</head>
<body>
<h1>cortex — authorize access</h1>
<form method="POST" action="${action}">
  <label for="password">Password</label>
  <input id="password" type="password" name="password" autofocus required>
  <button type="submit">Continue</button>
  ${errorHtml}
</form>
<p class="note">This server requires a shared password before issuing OAuth codes.</p>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleToken(req: Request, config: OAuthHandlerConfig): Promise<Response> {
  const form = await parseForm(req);
  if (form === null) {
    return errorResponse("invalid_request", "expected application/x-www-form-urlencoded", 400);
  }
  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") {
    return handleAuthorizationCodeGrant(form, config);
  }
  if (grantType === "refresh_token") {
    return handleRefreshTokenGrant(form, config);
  }
  return errorResponse("unsupported_grant_type", `unknown grant_type: ${grantType}`, 400);
}

function handleRefreshTokenGrant(form: URLSearchParams, config: OAuthHandlerConfig): Response {
  const refreshToken = form.get("refresh_token");
  const clientId = form.get("client_id");
  if (refreshToken === null || clientId === null) {
    return errorResponse("invalid_request", "refresh_token and client_id required", 400);
  }

  const entry = config.store.findRefreshToken(refreshToken);
  if (!entry) return errorResponse("invalid_grant", "refresh_token not found", 400);
  if (entry.clientId !== clientId) {
    return errorResponse("invalid_grant", "client_id mismatch", 400);
  }
  if (entry.rotated) {
    return errorResponse("invalid_grant", "refresh_token already rotated (reuse detected)", 400);
  }

  config.store.markRefreshRotated(refreshToken);

  const now = Date.now();
  const newAccessToken = randomBytes(32).toString("base64url");
  const newRefreshToken = randomBytes(32).toString("base64url");
  config.store.putAccessToken({
    token: newAccessToken,
    clientId,
    expiresAt: now + config.accessTokenTtlSec * 1000,
  });
  config.store.putRefreshToken({
    token: newRefreshToken,
    clientId,
    issuedAt: now,
    rotated: false,
  });

  return json({
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
    token_type: "Bearer",
    expires_in: config.accessTokenTtlSec,
  });
}

function handleAuthorizationCodeGrant(form: URLSearchParams, config: OAuthHandlerConfig): Response {
  const code = form.get("code");
  const redirectUri = form.get("redirect_uri");
  const clientId = form.get("client_id");
  const verifier = form.get("code_verifier");

  if (code === null || redirectUri === null || clientId === null || verifier === null) {
    return errorResponse(
      "invalid_request",
      "code, redirect_uri, client_id, code_verifier required",
      400,
    );
  }

  const entry = config.store.consumeCode(code);
  if (!entry) return errorResponse("invalid_grant", "code invalid or expired", 400);
  if (entry.clientId !== clientId) {
    return errorResponse("invalid_grant", "client_id mismatch", 400);
  }
  if (entry.redirectUri !== redirectUri) {
    return errorResponse("invalid_grant", "redirect_uri mismatch", 400);
  }
  if (
    !verifyPkce({
      verifier,
      challenge: entry.codeChallenge,
      method: entry.codeChallengeMethod,
    })
  ) {
    return errorResponse("invalid_grant", "PKCE verification failed", 400);
  }

  const now = Date.now();
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = now + config.accessTokenTtlSec * 1000;
  config.store.putAccessToken({ token: accessToken, clientId, expiresAt });
  config.store.putRefreshToken({
    token: refreshToken,
    clientId,
    issuedAt: now,
    rotated: false,
  });

  return json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: config.accessTokenTtlSec,
  });
}

async function parseForm(req: Request): Promise<URLSearchParams | null> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/x-www-form-urlencoded")) return null;
  const text = await req.text();
  return new URLSearchParams(text);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(error: string, description: string, status: number): Response {
  return json({ error, error_description: description }, status);
}
