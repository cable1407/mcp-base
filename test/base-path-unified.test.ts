import { describe, expect, test } from "bun:test";
import { createUnifiedHandler } from "../src/dispatcher.ts";

type Handler = (req: Request) => Promise<Response>;

const makeTracker = (label: string): Handler & { paths: string[] } => {
  const paths: string[] = [];
  const h = async (req: Request): Promise<Response> => {
    paths.push(new URL(req.url).pathname);
    return new Response(label);
  };
  return Object.assign(h, { paths });
};

describe("createUnifiedHandler with basePath", () => {
  test("when basePath is '', behavior matches the root-mounted handler", async () => {
    const mcp = makeTracker("mcp");
    const push = makeTracker("push");
    const handler = createUnifiedHandler({ mcp, push, basePath: "" });
    expect(await (await handler(new Request("http://x/mcp", { method: "POST" }))).text()).toBe(
      "mcp",
    );
    expect(await (await handler(new Request("http://x/health"))).text()).toBe("push");
  });

  test("with basePath '/cortex', /cortex/mcp routes to the MCP handler and it sees /mcp", async () => {
    const mcp = makeTracker("mcp");
    const push = makeTracker("push");
    const handler = createUnifiedHandler({ mcp, push, basePath: "/cortex" });
    const res = await handler(new Request("http://x/cortex/mcp", { method: "POST" }));
    expect(await res.text()).toBe("mcp");
    expect(mcp.paths).toEqual(["/mcp"]);
  });

  test("with basePath '/cortex', /cortex/health routes to push and it sees /health", async () => {
    const mcp = makeTracker("mcp");
    const push = makeTracker("push");
    const handler = createUnifiedHandler({ mcp, push, basePath: "/cortex" });
    const res = await handler(new Request("http://x/cortex/health"));
    expect(await res.text()).toBe("push");
    expect(push.paths).toEqual(["/health"]);
  });

  test("with basePath '/cortex', OAuth endpoints under the prefix route to the oauth handler with bare paths", async () => {
    const mcp = makeTracker("mcp");
    const push = makeTracker("push");
    const oauth = makeTracker("oauth");
    const handler = createUnifiedHandler({ mcp, push, oauth, basePath: "/cortex" });
    expect(await (await handler(new Request("http://x/cortex/authorize"))).text()).toBe("oauth");
    expect(await (await handler(new Request("http://x/cortex/token"))).text()).toBe("oauth");
    expect(
      await (
        await handler(new Request("http://x/cortex/.well-known/oauth-authorization-server"))
      ).text(),
    ).toBe("oauth");
    expect(oauth.paths.sort()).toEqual([
      "/.well-known/oauth-authorization-server",
      "/authorize",
      "/token",
    ]);
  });

  test("with basePath set, unprefixed requests return 404", async () => {
    const mcp = makeTracker("mcp");
    const push = makeTracker("push");
    const handler = createUnifiedHandler({ mcp, push, basePath: "/cortex" });
    const res = await handler(new Request("http://x/mcp"));
    expect(res.status).toBe(404);
    expect(mcp.paths).toEqual([]);
    expect(push.paths).toEqual([]);
  });

  test("with basePath set, partial-segment near-matches are 404 (not false-routed)", async () => {
    const mcp = makeTracker("mcp");
    const push = makeTracker("push");
    const handler = createUnifiedHandler({ mcp, push, basePath: "/cortex" });
    const res = await handler(new Request("http://x/cortex2/mcp"));
    expect(res.status).toBe(404);
  });

  test("with basePath, POST body and headers propagate to the downstream handler", async () => {
    interface Seen {
      method: string;
      contentType: string | null;
      body: string;
    }
    const seen: { value: Seen | null } = { value: null };
    const push: Handler = async (req) => {
      seen.value = {
        method: req.method,
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      };
      return new Response("ok");
    };
    const mcp = makeTracker("mcp");
    const handler = createUnifiedHandler({ mcp, push, basePath: "/cortex" });
    await handler(
      new Request("http://x/cortex/index", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"hello":"world"}',
      }),
    );
    expect(seen.value).not.toBeNull();
    expect(seen.value?.method).toBe("POST");
    expect(seen.value?.contentType).toBe("application/json");
    expect(seen.value?.body).toBe('{"hello":"world"}');
  });
});
