import type {
  AccessToken,
  AuthorizationCode,
  OAuthClient,
  OAuthStore,
  RefreshToken,
} from "./types.ts";

export class InMemoryOAuthStore implements OAuthStore {
  private readonly clients = new Map<string, OAuthClient>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, AccessToken>();
  private readonly refreshTokens = new Map<string, RefreshToken>();

  registerClient(client: OAuthClient): void {
    this.clients.set(client.clientId, client);
  }

  findClient(clientId: string): OAuthClient | null {
    return this.clients.get(clientId) ?? null;
  }

  putCode(code: AuthorizationCode): void {
    this.codes.set(code.code, code);
  }

  consumeCode(code: string): AuthorizationCode | null {
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code);
    if (entry.expiresAt < Date.now()) return null;
    return entry;
  }

  putAccessToken(token: AccessToken): void {
    this.accessTokens.set(token.token, token);
  }

  findAccessToken(token: string): AccessToken | null {
    return this.accessTokens.get(token) ?? null;
  }

  putRefreshToken(token: RefreshToken): void {
    this.refreshTokens.set(token.token, token);
  }

  findRefreshToken(token: string): RefreshToken | null {
    return this.refreshTokens.get(token) ?? null;
  }

  markRefreshRotated(token: string): void {
    const entry = this.refreshTokens.get(token);
    if (!entry) return;
    this.refreshTokens.set(token, { ...entry, rotated: true });
  }
}
