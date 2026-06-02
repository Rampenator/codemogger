import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { chunkFile } from "../src/chunk/treesitter.ts";
import { detectLanguage } from "../src/chunk/languages.ts";

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function chunks(filePath: string, content: string) {
  const config = detectLanguage(filePath);
  if (!config) throw new Error(`no language for ${filePath}`);
  return chunkFile(filePath, content, hash(content), config);
}

describe("chunkFile", () => {
  test("chunks TypeScript describe and it DSL calls", async () => {
    const result = await chunks("/tmp/example.test.ts", `
describe("ISECure no-supported-files behavior", () => {
  it("returns no files when extensions do not match", () => {
    expect(true).toBe(true);
  });
});
`);

    const tests = result.filter(c => c.kind === "test");
    expect(tests.map(c => c.name)).toEqual([
      "ISECure no-supported-files behavior",
      "returns no files when extensions do not match",
    ]);
    expect(tests[0]!.signature).toBe("describe(\"ISECure no-supported-files behavior\", () => {");
  });

  test("chunks JavaScript test DSL calls", async () => {
    const result = await chunks("/tmp/example.test.js", `
test("indexes JavaScript tests", () => {
  expect(true).toBe(true);
});
`);

    expect(result.filter(c => c.kind === "test").map(c => c.name)).toEqual([
      "indexes JavaScript tests",
    ]);
  });

  test("keeps normal TypeScript declaration chunks", async () => {
    const result = await chunks("/tmp/example.ts", `
export function add(a: number, b: number): number {
  return a + b;
}
`);

    expect(result.some(c => c.kind === "function" && c.name === "add")).toBe(true);
  });
});
