import { describe, expect, test } from "bun:test";
import { createMcpServer } from "../src/index.ts";

describe("scaffold", () => {
  test("createMcpServer is exported as a function", () => {
    expect(typeof createMcpServer).toBe("function");
  });

  test("createMcpServer rejects with the 'extraction in progress' error (Phase 1 stub)", async () => {
    await expect(
      createMcpServer({
        name: "test",
        port: 0,
        mcpHandler: async () => new Response(),
      }),
    ).rejects.toThrow(/not implemented/i);
  });
});
