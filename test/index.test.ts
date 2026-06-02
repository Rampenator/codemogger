import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { CodeIndex } from "../src/index.ts";
import { withDbWriterLock } from "../src/db/safety.ts";

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `codemogger-idx-${Date.now()}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeIndex(dbPath: string) {
  // Dummy embedder: returns a zero vector of the right dimension (384)
  const embedder = async (texts: string[]) =>
    texts.map(() => Array.from({ length: 384 }, () => 0));
  return new CodeIndex({ dbPath, embedder, embeddingModel: "test-model" });
}

function vector(first: number, second: number) {
  return [first, second, ...Array.from({ length: 382 }, () => 0)];
}

function makeScopedIndex(dbPath: string) {
  const embedder = async (texts: string[]) =>
    texts.map((text) => {
      if (text.includes("/service-a/")) return vector(0.8, 0.2);
      if (text.includes("/service-b/")) return vector(1, 0);
      return vector(1, 0);
    });
  return new CodeIndex({ dbPath, embedder, embeddingModel: "test-model" });
}

test("indexes a directory and returns chunk count", async () => {
  await writeFile(join(dir, "foo.ts"), `
export function add(a: number, b: number): number {
  return a + b;
}
export function sub(a: number, b: number): number {
  return a - b;
}
  `);
  const dbPath = join(dir, "test.db");
  const idx = makeIndex(dbPath);
  const result = await idx.index(dir);
  expect(result.errors).toHaveLength(0);
  expect(result.chunks).toBeGreaterThan(0);
});

test("embedding batch errors are recorded in IndexResult.errors", async () => {
  await writeFile(join(dir, "foo.ts"), "export function hello() {}");
  const dbPath = join(dir, "test.db");
  let callCount = 0;
  const failingEmbedder = async (texts: string[]) => {
    callCount++;
    throw new Error("mock embed failure");
  };
  const idx = new CodeIndex({ dbPath, embedder: failingEmbedder, embeddingModel: "test-model" });
  const result = await idx.index(dir);
  // Should not throw; errors should be captured
  expect(result.errors.some(e => e.includes("mock embed failure"))).toBe(true);
  expect(callCount).toBeGreaterThan(0);
});

test("re-indexing unchanged files does not duplicate chunks", async () => {
  await writeFile(join(dir, "foo.ts"), "export function hello() {}");
  const dbPath = join(dir, "test.db");
  const idx = makeIndex(dbPath);
  const r1 = await idx.index(dir);
  const r2 = await idx.index(dir);
  // Second run: no new chunks (file hash unchanged, already skipped)
  expect(r2.skipped).toBe(1);
  expect(r1.chunks).toBeGreaterThan(0);
});

test("re-index removes files that become excluded", async () => {
  await writeFile(join(dir, "keep.ts"), "export function keepFunction() {}");
  await writeFile(join(dir, "gone.ts"), "export function goneFunction() {}");
  const dbPath = join(dir, "test.db");
  const idx = makeIndex(dbPath);

  const r1 = await idx.index(dir);
  expect(r1.chunks).toBeGreaterThan(0);
  expect(await idx.search("goneFunction", { mode: "keyword" })).toHaveLength(1);

  await writeFile(join(dir, ".gitignore"), "gone.ts\n");
  const r2 = await idx.index(dir);

  expect(r2.removed).toBe(1);
  expect((await idx.listFiles()).map(f => f.filePath).sort()).toEqual([join(dir, "keep.ts")]);
  expect(await idx.search("goneFunction", { mode: "keyword" })).toHaveLength(0);
  await idx.close();
});

test("scoped search supports global boost and filter", async () => {
  await mkdir(join(dir, "service-a"), { recursive: true });
  await mkdir(join(dir, "service-b"), { recursive: true });
  await writeFile(join(dir, "service-a", "match.ts"), "export function needle() { return \"inside\"; }");
  await writeFile(join(dir, "service-b", "match.ts"), "export function needle() { return \"outside\"; }");
  const idx = makeScopedIndex(join(dir, "test.db"));
  await idx.index(dir);

  const global = await idx.search("needle", { mode: "semantic", limit: 2 });
  expect(global[0]!.filePath).toContain("/service-b/");

  const filtered = await idx.search("needle", { mode: "semantic", limit: 2, scope: "service-a", scopeMode: "filter" });
  expect(filtered).toHaveLength(1);
  expect(filtered[0]!.filePath).toContain("/service-a/");

  const boosted = await idx.search("needle", { mode: "semantic", limit: 2, scope: "service-a", scopeMode: "boost" });
  expect(boosted).toHaveLength(2);
  expect(boosted[0]!.filePath).toContain("/service-a/");
  expect(boosted.some(r => r.filePath.includes("/service-b/"))).toBe(true);

  for (const mode of ["keyword", "hybrid"] as const) {
    const results = await idx.search("needle", { mode, limit: 5, scope: "service-a", scopeMode: "filter" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.filePath.includes("/service-a/"))).toBe(true);
  }
  await idx.close();
});

test("index fails fast when another writer holds the DB lock", async () => {
  await writeFile(join(dir, "foo.ts"), "export function hello() {}");
  const dbPath = join(dir, "test.db");
  const idx = makeIndex(dbPath);

  await withDbWriterLock(dbPath, async () => {
    await expect(idx.index(dir)).rejects.toThrow("Another Codemogger writer is active");
  });
  await idx.close();
});
