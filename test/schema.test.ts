import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { CodeIndex } from "../src/index.ts";
import { withDbWriterLock } from "../src/db/safety.ts";

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `codemogger-schema-${Date.now()}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeIndex(dbPath: string) {
  const embedder = async (texts: string[]) =>
    texts.map(() => Array.from({ length: 384 }, () => 0));
  return new CodeIndex({ dbPath, embedder, embeddingModel: "test-model" });
}

async function writeSnapshot(source: string, manifest = {
  schemaPulledAt: "2026-06-02T12:00:00.000Z",
  schemas: ["portfolios"],
}) {
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "table_names.csv"), [
    "table_schema,table_name,approximate_rows",
    "portfolios,time_series,77.9M",
    "portfolios,companies,100",
  ].join("\n"));
  await writeFile(join(source, "column_info.csv"), [
    "table_schema,table_name,column_name,data_type,is_nullable,ordinal_position",
    "portfolios,time_series,company_id,bigint,NO,1",
    "portfolios,time_series,portfolio_id,bigint,NO,2",
    "portfolios,time_series,type,text,NO,3",
    "portfolios,time_series,info_date,date,NO,4",
    "portfolios,time_series,value,numeric,YES,5",
    "portfolios,companies,id,bigint,NO,1",
    "portfolios,companies,name,text,NO,2",
  ].join("\n"));
  await writeFile(join(source, "foreign_key_relations.csv"), [
    "source_schema,source_table,source_column,target_schema,target_table,target_column,constraint_name",
  ].join("\n"));
  await writeFile(join(source, "indexes.csv"), [
    "table_schema,table_name,index_name,column_name,is_primary,is_unique,ordinal_position",
    "portfolios,time_series,time_series_pkey,company_id,true,true,1",
    "portfolios,time_series,time_series_pkey,portfolio_id,true,true,2",
    "portfolios,time_series,time_series_pkey,type,true,true,3",
    "portfolios,time_series,time_series_pkey,info_date,true,true,4",
    "portfolios,companies,companies_pkey,id,true,true,1",
  ].join("\n"));
  await writeFile(join(source, "manifest.json"), JSON.stringify(manifest, null, 2));
}

async function writeUppercaseStmStyleSnapshot(source: string, tableCount = 306) {
  await mkdir(source, { recursive: true });
  const tables = ["TABLE_SCHEMA,TABLE_NAME,TABLE_ROWS", "portfolios,time_series,77919663"];
  const columns = [
    "TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,DATA_TYPE,IS_NULLABLE,ORDINAL_POSITION",
    "portfolios,time_series,company_id,bigint,NO,1",
    "portfolios,time_series,portfolio_id,bigint,NO,2",
    "portfolios,time_series,type,text,NO,3",
    "portfolios,time_series,info_date,date,NO,4",
    "portfolios,time_series,value,numeric,YES,5",
  ];
  const indexes = [
    "TABLE_SCHEMA,TABLE_NAME,INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX,NON_UNIQUE",
    "portfolios,time_series,PRIMARY,company_id,1,0",
    "portfolios,time_series,PRIMARY,portfolio_id,2,0",
    "portfolios,time_series,PRIMARY,type,3,0",
    "portfolios,time_series,PRIMARY,info_date,4,0",
  ];

  for (let i = 1; i < tableCount; i++) {
    const table = `fixture_table_${String(i).padStart(3, "0")}`;
    tables.push(`portfolios,${table},${i}`);
    columns.push(`portfolios,${table},id,bigint,NO,1`);
    indexes.push(`portfolios,${table},PRIMARY,id,1,0`);
  }

  await writeFile(join(source, "table_names.csv"), tables.join("\n"));
  await writeFile(join(source, "column_info.csv"), columns.join("\n"));
  await writeFile(join(source, "foreign_key_relations.csv"), [
    "TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME,CONSTRAINT_NAME",
  ].join("\n"));
  await writeFile(join(source, "indexes.csv"), indexes.join("\n"));
  await writeFile(join(source, "manifest.json"), JSON.stringify({
    schemaPulledAt: "2026-06-02T12:00:00.000Z",
    schemas: ["portfolios"],
  }, null, 2));
}

describe("schema snapshot indexing", () => {
  test("writes database table chunks with composite PK and no-FK signature", async () => {
    const source = join(dir, "portfolios-schema");
    const dbPath = join(dir, "cache", "codemogger.db");
    await writeSnapshot(source);

    const idx = makeIndex(dbPath);
    const result = await idx.indexSchemaSnapshot(source);
    const chunks = JSON.parse(await readFile(result.chunksPath, "utf-8"));
    const timeSeries = chunks.find((c: { name: string }) => c.name === "portfolios.time_series");

    expect(result.chunksPath).toBe(join(dir, "cache", "schema", "portfolios-schema-chunks.json"));
    expect(timeSeries.kind).toBe("database_table");
    expect(timeSeries.signature).toBe("table portfolios.time_series(pk: company_id, portfolio_id, type, info_date; fk: none) rows~77.9M");
    expect(timeSeries.signature).not.toContain("pk: id");
    expect(timeSeries.snippet).toContain("company_id bigint not null");
    expect(timeSeries.snippet).toContain("indexes:");
    await idx.close();
  });

  test("indexes database table chunks for search with snippets optional", async () => {
    const source = join(dir, "portfolios-schema");
    await writeSnapshot(source);
    const idx = makeIndex(join(dir, "cache", "codemogger.db"));
    await idx.indexSchemaSnapshot(source);

    const compact = await idx.search("time_series", { mode: "keyword", includeSnippet: false });
    expect(compact[0]!.kind).toBe("database_table");
    expect(compact[0]!.name).toBe("portfolios.time_series");
    expect(compact[0]!.snippet).toBe("");

    const verbose = await idx.search("time_series", { mode: "keyword", includeSnippet: true });
    expect(verbose[0]!.snippet).toContain("primary_key: company_id, portfolio_id, type, info_date");
    await idx.close();
  });

  test("handles uppercase STM-style headers as separate real table chunks", async () => {
    const source = join(dir, "portfolios-schema");
    const dbPath = join(dir, "cache", "codemogger.db");
    await writeUppercaseStmStyleSnapshot(source);

    const idx = makeIndex(dbPath);
    const result = await idx.indexSchemaSnapshot(source);
    const chunks = JSON.parse(await readFile(result.chunksPath, "utf-8")) as { name: string; signature: string }[];
    const names = new Set(chunks.map(c => c.name));
    const timeSeries = chunks.find(c => c.name === "portfolios.time_series");

    expect(chunks).toHaveLength(306);
    expect(names.size).toBe(306);
    expect(names.has(".")).toBe(false);
    expect(timeSeries!.signature).toBe("table portfolios.time_series(pk: company_id, portfolio_id, type, info_date; fk: none) rows~77919663");
    await idx.close();
  });

  test("schema index preserves existing code index content in the same DB", async () => {
    const source = join(dir, "portfolios-schema");
    const codeDir = join(dir, "code");
    const dbPath = join(dir, "cache", "codemogger.db");
    await writeUppercaseStmStyleSnapshot(source, 2);
    await mkdir(codeDir, { recursive: true });
    await writeFile(join(codeDir, "handler.ts"), "export function preserveCodeIndex() { return true; }");

    const idx = makeIndex(dbPath);
    await idx.index(codeDir);
    const before = await idx.listFiles();
    await idx.indexSchemaSnapshot(source);
    const after = await idx.listFiles();

    expect(before.some(f => f.filePath.endsWith("handler.ts"))).toBe(true);
    expect(after.some(f => f.filePath.endsWith("handler.ts"))).toBe(true);
    expect(after.some(f => f.filePath.endsWith("portfolios-schema-chunks.json"))).toBe(true);
    expect(await idx.search("preserveCodeIndex", { mode: "keyword" })).toHaveLength(1);
    await idx.close();
  });

  test("rejects manifest without valid schemaPulledAt", async () => {
    const source = join(dir, "bad-schema");
    await writeSnapshot(source, { schemaPulledAt: "not-a-date", schemas: ["portfolios"] });
    const idx = makeIndex(join(dir, "cache", "codemogger.db"));

    await expect(idx.indexSchemaSnapshot(source)).rejects.toThrow("schemaPulledAt");
    await idx.close();
  });

  test("CLI schema index writes derived artifacts under dirname(db)/schema", async () => {
    const source = join(dir, "portfolios-schema");
    const dbPath = join(dir, "cache", "codemogger.db");
    await writeSnapshot(source);

    const proc = Bun.spawn([
      "bun",
      "bin/codemogger.ts",
      "schema",
      "index",
      "--source",
      source,
      "--db",
      dbPath,
    ], {
      cwd: "/Users/ramu/Projects/codemogger",
      env: { ...process.env, CODEMOGGER_TEST_EMBEDDINGS: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Indexed schema snapshot: 2 tables");
    expect(await readFile(join(dir, "cache", "schema", "portfolios-schema-chunks.json"), "utf-8")).toContain("portfolios.time_series");
    expect(await readFile(join(dir, "cache", "schema", "manifest.json"), "utf-8")).toContain("schemaPulledAt");
  });

  test("schema index fails fast when another writer holds the DB lock", async () => {
    const source = join(dir, "portfolios-schema");
    const dbPath = join(dir, "cache", "codemogger.db");
    await writeSnapshot(source);
    const idx = makeIndex(dbPath);

    await withDbWriterLock(dbPath, async () => {
      await expect(idx.indexSchemaSnapshot(source)).rejects.toThrow("Another Codemogger writer is active");
    });
    await idx.close();
  });
});
