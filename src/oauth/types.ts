export interface OAuthClient {
  clientId: string;
  redirectUris: readonly string[];
}

export type CodeChallengeMethod = "S256" | "plain";

export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: CodeChallengeMethod;
  expiresAt: number;
}

export interface AccessToken {
  token: string;
  clientId: string;
  expiresAt: number;
}

export interface RefreshToken {
  token: string;
  clientId: string;
  issuedAt: number;
  rotated: boolean;
}

export interface OAuthStore {
  registerClient(client: OAuthClient): void;
  findClient(clientId: string): OAuthClient | null;

  putCode(code: AuthorizationCode): void;
  consumeCode(code: string): AuthorizationCode | null;

  putAccessToken(token: AccessToken): void;
  findAccessToken(token: string): AccessToken | null;

  putRefreshToken(token: RefreshToken): void;
  findRefreshToken(token: string): RefreshToken | null;
  markRefreshRotated(token: string): void;
}
