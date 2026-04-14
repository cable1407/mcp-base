import { beforeEach, describe, expect, test } from "bun:test";
import { withAccessLog } from "../src/access-log.ts";

type Handler = (req: Request) => Promise<Response>;

const mkInner =
  (status = 200): Handler =>
  async () =>
    new Response("ok", { status });

describe("withAccessLog", () => {
  let lines: string[];
  let log: (line: string) => void;

  beforeEach(() => {
    lines = [];
    log = (line: string) => {
      lines.push(line);
    };
  });

  test("when enabled, prints one line per request with ISO-8601 UTC timestamp, [http] prefix, IP, method, path, status, ms, ua", async () => {
    const h = withAccessLog({ enabled: true, log }, mkInner(200));
    await h(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "user-agent": "claude-ai/1.2.3", "x-forwarded-for": "203.0.113.7" },
      }),
    );
    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    // ISO-8601 UTC with millis, then [http] prefix.
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[http\] /);
    expect(line).toContain("203.0.113.7");
    expect(line).toContain("POST /mcp 200");
    expect(line).toMatch(/\d+ms/);
    expect(line).toContain('ua="claude-ai/1.2.3"');
  });

  test("timestamp is parseable back to a Date within a small delta of 'now'", async () => {
    const before = Date.now();
    const h = withAccessLog({ enabled: true, log }, mkInner(200));
    await h(new Request("http://x/health"));
    const after = Date.now();
    const line = lines[0] as string;
    const ts = line.split(" ")[0] as string;
    const parsed = Date.parse(ts);
    expect(Number.isNaN(parsed)).toBe(false);
    // Allow 1s of slack; the request completes well inside that window.
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(after + 1000);
  });

  test("reflects the actual response status code (e.g. 401)", async () => {
    const h = withAccessLog({ enabled: true, log }, mkInner(401));
    await h(new Request("http://x/mcp"));
    expect(lines[0]).toContain(" 401 ");
  });

  test("when disabled, logs nothing", async () => {
    const h = withAccessLog({ enabled: false, log }, mkInner(200));
    await h(new Request("http://x/health"));
    expect(lines).toHaveLength(0);
  });

  test("strips query string from the logged path (so OAuth codes / state never land in logs)", async () => {
    const h = withAccessLog({ enabled: true, log }, mkInner(302));
    await h(new Request("http://x/authorize?client_id=c&code_challenge=CH&state=xyz"));
    const line = lines[0] as string;
    expect(line).toContain(" /authorize ");
    expect(line).not.toContain("code_challenge");
    expect(line).not.toContain("state=xyz");
  });

  test("truncates user-agent at 200 chars to bound log size", async () => {
    const h = withAccessLog({ enabled: true, log }, mkInner(200));
    const huge = "x".repeat(500);
    await h(new Request("http://x/health", { headers: { "user-agent": huge } }));
    const line = lines[0] as string;
    const uaMatch = line.match(/ua="([^"]*)"$/);
    expect(uaMatch).not.toBeNull();
    expect((uaMatch?.[1] ?? "").length).toBe(200);
  });

  test("uses the first entry of X-Forwarded-For when present", async () => {
    const h = withAccessLog({ enabled: true, log }, mkInner(200));
    await h(
      new Request("http://x/health", {
        headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.5, 100.64.1.1" },
      }),
    );
    expect(lines[0]).toContain("203.0.113.7");
    expect(lines[0]).not.toContain("10.0.0.5");
  });

  test("falls back to '-' when no X-Forwarded-For header is present", async () => {
    const h = withAccessLog({ enabled: true, log }, mkInner(200));
    await h(new Request("http://x/health"));
    const line = lines[0] as string;
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[http\] - /);
  });

  test("user-agent defaults to '-' when absent", async () => {
    const h = withAccessLog({ enabled: true, log }, mkInner(200));
    await h(new Request("http://x/health"));
    expect(lines[0]).toContain('ua="-"');
  });

  test("does not alter the response passed through", async () => {
    const h = withAccessLog({ enabled: true, log }, mkInner(201));
    const res = await h(new Request("http://x/index", { method: "POST" }));
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("ok");
  });
});
