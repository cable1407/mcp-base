// Phase 1 scaffold — types and the `createMcpServer` entry point are
// declared here so consumers can import without breakage, but the
// implementation is extracted from cortex in Phase 2. The stub throws a
// clear, actionable error so anything that calls it during Phase 1 fails
// loudly instead of silently.

export interface OAuthConfig {
  readonly enabled: boolean;
  readonly issuer: string;
  readonly storePath: string;
  readonly accessTokenTtlSec: number;
  readonly authPassword: string;
  readonly clientId?: string;
  readonly redirectUris?: readonly string[];
}

export type Handler = (req: Request) => Promise<Response>;

export interface ExtraRoute {
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  readonly path: string;
  readonly handler: Handler;
  readonly requireToken?: string;
  readonly public?: boolean;
}

export interface McpServerConfig {
  readonly name: string;
  readonly port: number;
  readonly basePath?: string;
  readonly oauth?: OAuthConfig;
  readonly accessLog?: boolean;
  readonly mcpHandler: Handler;
  readonly extraRoutes?: readonly ExtraRoute[];
}

export interface McpServer {
  listen(): void;
  stop(): Promise<void>;
}

export async function createMcpServer(_config: McpServerConfig): Promise<McpServer> {
  throw new Error(
    "mcp-base: createMcpServer is not implemented — extraction in progress (see cable1407/mcp-base#2)",
  );
}
