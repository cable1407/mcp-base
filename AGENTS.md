# mcp-base

Shared TypeScript foundation for Model Context Protocol (MCP) servers. One
OAuth 2.0 + OIDC discovery + consent + CORS + access-logging stack that
every consumer (cortex, second-brain-mcp-server, future MCP servers) pins
via git-dependency. Keeps the auth perimeter in one place; a fix here
propagates to the fleet via a version bump.

## Conventions

- TypeScript, `strict: true`, `exactOptionalPropertyTypes: true`. No `any`
  in source. Tests may use `any` when typing is genuinely hard.
- Bun — runtime, test runner, package manager. ESM (`"type": "module"`).
- Tests in `.test.ts`, colocated (`test/*.test.ts`).
- Linter: biome (`biome check src test`).
- No public npm; consumers pin `github:cable1407/mcp-base#vX.Y.Z`.
- Semver tagging. Breaking changes bump major + require migration notes in
  the release body.

## Review emphasis

- **OAuth RFC compliance is the #1 surface.** Changes under `src/oauth/`
  must respect the relevant specs:
  - RFC 6749 (OAuth 2.0 core — auth code + refresh grant, `invalid_grant`
    = 400 per §5.2)
  - PKCE (`S256` + `plain`; comparison must be timing-safe)
  - RFC 7591 (Dynamic Client Registration)
  - RFC 8414 + OIDC discovery (authorization-server metadata)
  - RFC 9728 (protected-resource metadata at `/.well-known/oauth-protected-resource`)
  Dropping a requirement from any of these breaks claude.ai's connector
  probe sequence; tests exist for each and should stay green.
- **API shape is load-bearing for consumers.** cortex + second-brain-mcp-server
  pin this repo by tag; an accidental rename, removed export, or changed
  function signature shows up as a TS build failure in consumers after
  they bump. Mark breaking changes explicitly and bump major.
- **Timing-safe comparisons for any secret material.** mcp-base uses
  public PKCE clients (no per-client client-secrets). Current timing-safe
  paths: PKCE verifier check, consent-form `authPassword` gate in
  `oauth/endpoints.ts` (via `timingSafeEqualStrings`). Access-token lookup
  in `oauth/middleware.ts` goes through a hash-map (`store.findAccessToken`);
  if the store is ever extended with a constant-time requirement, flag it.
  Any NEW secret comparison must use `timingSafeEqualStrings` or
  `node:crypto timingSafeEqual`, never `===`.
- **CORS surface.** The `withCors` middleware is the wire that lets
  browser-based MCP clients work. Changes to allowed origins, headers, or
  the preflight (OPTIONS) response need explicit test coverage.
- **Consent + authPassword contract.** When `oauth.enabled`, the consent
  form's `authPassword` gate is required; silently bypassing it (or
  letting a missing env var gate it open) is a security regression.
- **MCP transport handler asymmetry is intentional — don't "fix" it.**
  `createSessionedMcpHandler` requires an `initialize` request (no
  session id) to spawn a session and rejects other methods-without-sid
  with 400. `createStatelessMcpHandler` spawns a fresh pair for every
  request, no `initialize` precondition. The asymmetry is the point; the
  review lens is whether tool-dispatch semantics match once a session
  exists (for sessioned) or on any request (for stateless), not whether
  the `initialize`-entry surfaces match.

## Test commands

- `bun test`
- `tsc --noEmit`
- `biome check src test`

All three must pass clean. Release-helper refuses to tag if any fail.

## Doc mapping

- User docs: `README.md` (public-facing integration guide)
- Design doc: operator's Second Brain — path varies per deployment;
  `doc-syncer` receives the specific mapping from the parent at
  invocation time (per-agent branches may ship a branch-local override
  of this section with a concrete path)
- Release notes: `CHANGELOG.md` — does NOT yet exist; `release-helper`
  creates it on first release and appends to it thereafter

## Release playbook

mcp-base is the one repo in the fleet that has real downstream consumers
via git-dep. Release flow:

1. Bump `version` in `package.json` (semver).
2. Create `CHANGELOG.md` on first release, or append a new `## vX.Y.Z`
   section to the existing one. Each entry: dated summary, user-visible
   changes, migration note if a breaking API shape changed.
3. Commit: `chore: release vX.Y.Z`.
4. Tag: `git tag vX.Y.Z` (must match the `package.json` version exactly).
5. Push: `git push origin main --tags`.
6. For each consumer with a stale pin, open a migration PR that ONLY bumps
   `"mcp-base"` in `package.json`. Consumer repos to check on every
   release:
   - `cable1407/cortex` (`package.json` → `mcp-base`)
   - `cable1407/second-brain-mcp-server` (`package.json` → `mcp-base`)
   PR title: `mcp-base: bump to vX.Y.Z`. PR body links the release notes.
7. `release-helper` subagent automates steps 1-6 under `isolation: worktree`.
   Operator confirms before `git tag` and before opening consumer PRs;
   never merges its own PRs.
