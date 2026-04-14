import fs from "node:fs";
import path from "node:path";
import type {
  AccessToken,
  AuthorizationCode,
  OAuthClient,
  OAuthStore,
  RefreshToken,
} from "./types.ts";

interface Persisted {
  clients: Record<string, OAuthClient>;
  codes: Record<string, AuthorizationCode>;
  accessTokens: Record<string, AccessToken>;
  refreshTokens: Record<string, RefreshToken>;
}

const emptyState = (): Persisted => ({
  clients: {},
  codes: {},
  accessTokens: {},
  refreshTokens: {},
});

export class FileOAuthStore implements OAuthStore {
  private readonly filePath: string;
  private state: Persisted;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.state = this.load();
  }

  private load(): Persisted {
    if (!fs.existsSync(this.filePath)) return emptyState();
    const raw = fs.readFileSync(this.filePath, "utf8");
    if (raw.trim() === "") return emptyState();
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      clients: parsed.clients ?? {},
      codes: parsed.codes ?? {},
      accessTokens: parsed.accessTokens ?? {},
      refreshTokens: parsed.refreshTokens ?? {},
    };
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  registerClient(client: OAuthClient): void {
    this.state.clients[client.clientId] = client;
    this.flush();
  }

  findClient(clientId: string): OAuthClient | null {
    return this.state.clients[clientId] ?? null;
  }

  putCode(code: AuthorizationCode): void {
    this.state.codes[code.code] = code;
    this.flush();
  }

  consumeCode(code: string): AuthorizationCode | null {
    const entry = this.state.codes[code];
    if (!entry) return null;
    delete this.state.codes[code];
    this.flush();
    if (entry.expiresAt < Date.now()) return null;
    return entry;
  }

  putAccessToken(token: AccessToken): void {
    this.state.accessTokens[token.token] = token;
    this.flush();
  }

  findAccessToken(token: string): AccessToken | null {
    return this.state.accessTokens[token] ?? null;
  }

  putRefreshToken(token: RefreshToken): void {
    this.state.refreshTokens[token.token] = token;
    this.flush();
  }

  findRefreshToken(token: string): RefreshToken | null {
    return this.state.refreshTokens[token] ?? null;
  }

  markRefreshRotated(token: string): void {
    const entry = this.state.refreshTokens[token];
    if (!entry) return;
    this.state.refreshTokens[token] = { ...entry, rotated: true };
    this.flush();
  }
}
