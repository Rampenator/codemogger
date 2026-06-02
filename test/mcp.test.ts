import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { formatMcpSearchResults, mcpSearchInputSchema } from "../src/mcp.ts";
import type { SearchResult } from "../src/db/store.ts";

function result(snippet = ""): SearchResult {
  return {
    chunkKey: "/repo/src/foo.ts:1:3",
    filePath: "/repo/src/foo.ts",
    name: "foo",
    kind: "function",
    signature: "function foo(): string",
    snippet,
    startLine: 1,
    endLine: 3,
    score: 1,
  };
}

describe("MCP search", () => {
  test("defaults includeSnippet to false", () => {
    const parsed = z.object(mcpSearchInputSchema).parse({ query: "foo" });
    expect(parsed.includeSnippet).toBe(false);
  });

  test("accepts hybrid mode", () => {
    const parsed = z.object(mcpSearchInputSchema).parse({ query: "foo", mode: "hybrid" });
    expect(parsed.mode).toBe("hybrid");
  });

  test("accepts scope filter mode", () => {
    const parsed = z.object(mcpSearchInputSchema).parse({ query: "foo", scope: "service-a", scopeMode: "filter" });
    expect(parsed.scope).toBe("service-a");
    expect(parsed.scopeMode).toBe("filter");
  });

  test("formats signature without snippet", () => {
    const text = formatMcpSearchResults([result()]);
    expect(text).toBe("1. /repo/src/foo.ts:1-3 [function] foo function foo(): string");
    expect(text).not.toContain("```");
  });

  test("formats snippet only when present", () => {
    const text = formatMcpSearchResults([result("function foo(): string { return \"x\" }")]);
    expect(text).toContain("function foo(): string");
    expect(text).toContain("```");
    expect(text).toContain("return \"x\"");
  });
});
