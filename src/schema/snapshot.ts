import { createHash } from "crypto";
import { lstat, mkdir, readFile, writeFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string;
  ordinal: number;
}

export interface SchemaForeignKey {
  columns: string[];
  targetSchema: string;
  targetTable: string;
  targetColumns: string[];
  name: string;
}

export interface SchemaIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface SchemaTableChunk {
  schema: string;
  table: string;
  kind: "database_table";
  name: string;
  signature: string;
  snippet: string;
  approximateRows: string;
  primaryKey: string[];
  foreignKeys: SchemaForeignKey[];
  indexes: SchemaIndex[];
  columns: SchemaColumn[];
}

export interface SchemaSnapshotArtifacts {
  artifactDir: string;
  chunksPath: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  chunks: SchemaTableChunk[];
  chunksJson: string;
  chunksHash: string;
}

type CsvRow = Record<string, string>;

const REQUIRED_FILES = [
  "table_names.csv",
  "column_info.csv",
  "foreign_key_relations.csv",
  "indexes.csv",
  "manifest.json",
];

function csvCells(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (quoted) {
      if (ch === "\"" && content[i + 1] === "\"") {
        cell += "\"";
        i++;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === "\"") {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

function parseCsv(content: string): CsvRow[] {
  const rows = csvCells(content);
  const header = rows.shift()?.map(h => h.trim().toLowerCase()) ?? [];
  return rows.map((cells) => {
    const row: CsvRow = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]!] = cells[i]?.trim() ?? "";
    }
    return row;
  });
}

function value(row: CsvRow, names: string[]): string {
  for (const name of names) {
    const v = row[name];
    if (v != null && v !== "") return v;
  }
  return "";
}

function truthy(v: string): boolean {
  return ["true", "t", "yes", "y", "1"].includes(v.toLowerCase());
}

function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function parseOrdinal(v: string): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

async function readSnapshotFile(sourceDir: string, fileName: string): Promise<string> {
  const path = join(sourceDir, fileName);
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error(`${fileName} must not be a symlink`);
  return readFile(path, "utf-8");
}

function validateManifest(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const pulledAt = parsed.schemaPulledAt;
  if (typeof pulledAt !== "string" || Number.isNaN(Date.parse(pulledAt))) {
    throw new Error("manifest.json must contain a valid schemaPulledAt");
  }
  return parsed;
}

function artifactPrefix(sourceDir: string, manifest: Record<string, unknown>): string {
  const schemas = manifest.schemas;
  if (Array.isArray(schemas) && schemas.length === 1 && typeof schemas[0] === "string") {
    return `${schemas[0]}-schema`;
  }
  return basename(sourceDir).replace(/[^a-zA-Z0-9_.-]+/g, "-") || "schema-snapshot";
}

function primaryKeyFromIndexes(rows: CsvRow[], schema: string, table: string): string[] {
  return rows
    .filter(r => value(r, ["table_schema", "schema"]) === schema && value(r, ["table_name", "table"]) === table)
    .filter(r => truthy(value(r, ["is_primary", "is_primary_key", "primary"])) || value(r, ["index_name", "name"]).toLowerCase() === "primary")
    .sort((a, b) => parseOrdinal(value(a, ["ordinal_position", "column_position", "seq_in_index"])) - parseOrdinal(value(b, ["ordinal_position", "column_position", "seq_in_index"])))
    .map(r => value(r, ["column_name", "column"]));
}

function indexesForTable(rows: CsvRow[], schema: string, table: string): SchemaIndex[] {
  const grouped = new Map<string, CsvRow[]>();
  for (const row of rows) {
    if (value(row, ["table_schema", "schema"]) !== schema || value(row, ["table_name", "table"]) !== table) continue;
    const name = value(row, ["index_name", "name"]) || "unnamed_index";
    grouped.set(name, [...(grouped.get(name) ?? []), row]);
  }

  return [...grouped.entries()].map(([name, indexRows]) => ({
    name,
    columns: indexRows
      .sort((a, b) => parseOrdinal(value(a, ["ordinal_position", "column_position", "seq_in_index"])) - parseOrdinal(value(b, ["ordinal_position", "column_position", "seq_in_index"])))
      .map(r => value(r, ["column_name", "column"])),
    unique: indexRows.some(r => truthy(value(r, ["is_unique", "unique"])) || value(r, ["non_unique"]).toLowerCase() === "0"),
    primary: name.toLowerCase() === "primary" || indexRows.some(r => truthy(value(r, ["is_primary", "is_primary_key", "primary"]))),
  }));
}

function foreignKeysForTable(rows: CsvRow[], schema: string, table: string): SchemaForeignKey[] {
  const grouped = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const sourceSchema = value(row, ["source_schema", "table_schema", "schema"]);
    const sourceTable = value(row, ["source_table", "table_name", "table"]);
    if (sourceSchema !== schema || sourceTable !== table) continue;
    const name = value(row, ["constraint_name", "fk_name", "name"]) || `${schema}.${table}`;
    grouped.set(name, [...(grouped.get(name) ?? []), row]);
  }

  return [...grouped.entries()].map(([name, fkRows]) => ({
    name,
    columns: fkRows.map(r => value(r, ["source_column", "column_name", "column"])),
    targetSchema: value(fkRows[0]!, ["target_schema", "foreign_schema", "referenced_schema", "referenced_table_schema"]),
    targetTable: value(fkRows[0]!, ["target_table", "foreign_table", "referenced_table", "referenced_table_name"]),
    targetColumns: fkRows.map(r => value(r, ["target_column", "foreign_column", "referenced_column", "referenced_column_name"])),
  }));
}

function columnsForTable(rows: CsvRow[], schema: string, table: string): SchemaColumn[] {
  return rows
    .filter(r => value(r, ["table_schema", "schema"]) === schema && value(r, ["table_name", "table"]) === table)
    .sort((a, b) => parseOrdinal(value(a, ["ordinal_position", "position"])) - parseOrdinal(value(b, ["ordinal_position", "position"])))
    .map(r => ({
      name: value(r, ["column_name", "column"]),
      type: value(r, ["data_type", "type", "udt_name"]),
      nullable: value(r, ["is_nullable", "nullable"]).toLowerCase() !== "no" && !truthy(value(r, ["not_null"])),
      defaultValue: value(r, ["column_default", "default"]),
      ordinal: parseOrdinal(value(r, ["ordinal_position", "position"])),
    }));
}

function formatSignature(name: string, primaryKey: string[], foreignKeys: SchemaForeignKey[], approximateRows: string): string {
  const pk = primaryKey.length > 0 ? primaryKey.join(", ") : "none";
  const fk = foreignKeys.length > 0
    ? foreignKeys.map(f => `${f.columns.join(", ")} -> ${f.targetSchema}.${f.targetTable}.${f.targetColumns.join(", ")}`).join("; ")
    : "none";
  const rows = approximateRows ? ` rows~${approximateRows}` : "";
  return `table ${name}(pk: ${pk}; fk: ${fk})${rows}`;
}

function formatSnippet(chunk: Omit<SchemaTableChunk, "signature" | "snippet" | "kind">): string {
  const lines = [
    `table ${chunk.name}`,
    chunk.approximateRows ? `approximate_rows: ${chunk.approximateRows}` : null,
    `primary_key: ${chunk.primaryKey.length > 0 ? chunk.primaryKey.join(", ") : "none"}`,
    "columns:",
    ...chunk.columns.map(c => `- ${c.name} ${c.type}${c.nullable ? "" : " not null"}${c.defaultValue ? ` default ${c.defaultValue}` : ""}`),
    "foreign_keys:",
    ...(chunk.foreignKeys.length > 0
      ? chunk.foreignKeys.map(f => `- ${f.columns.join(", ")} -> ${f.targetSchema}.${f.targetTable}.${f.targetColumns.join(", ")}`)
      : ["- none"]),
    "indexes:",
    ...(chunk.indexes.length > 0
      ? chunk.indexes.map(i => `- ${i.name}${i.primary ? " primary" : ""}${i.unique ? " unique" : ""}: ${i.columns.join(", ")}`)
      : ["- none"]),
  ];
  return lines.filter((line): line is string => line != null).join("\n");
}

export async function buildSchemaSnapshotArtifacts(sourceDirInput: string, dbPath: string): Promise<SchemaSnapshotArtifacts> {
  const sourceDir = resolve(sourceDirInput);
  for (const fileName of REQUIRED_FILES) {
    await readSnapshotFile(sourceDir, fileName);
  }

  const [tablesCsv, columnsCsv, fksCsv, indexesCsv, manifestJson] = await Promise.all([
    readSnapshotFile(sourceDir, "table_names.csv"),
    readSnapshotFile(sourceDir, "column_info.csv"),
    readSnapshotFile(sourceDir, "foreign_key_relations.csv"),
    readSnapshotFile(sourceDir, "indexes.csv"),
    readSnapshotFile(sourceDir, "manifest.json"),
  ]);

  const manifest = validateManifest(manifestJson);
  const tableRows = parseCsv(tablesCsv);
  const columnRows = parseCsv(columnsCsv);
  const fkRows = parseCsv(fksCsv);
  const indexRows = parseCsv(indexesCsv);

  const chunks = tableRows.map((row) => {
    const schema = value(row, ["table_schema", "schema"]);
    const table = value(row, ["table_name", "table"]);
    if (!schema || !table) {
      throw new Error("table_names.csv rows must include table_schema and table_name");
    }
    const name = tableKey(schema, table);
    const primaryKey = primaryKeyFromIndexes(indexRows, schema, table);
    const foreignKeys = foreignKeysForTable(fkRows, schema, table);
    const indexes = indexesForTable(indexRows, schema, table);
    const columns = columnsForTable(columnRows, schema, table);
    const approximateRows = value(row, ["approximate_rows", "approx_rows", "estimated_rows", "row_count", "table_rows"]);
    const base = { schema, table, name, approximateRows, primaryKey, foreignKeys, indexes, columns };

    return {
      ...base,
      kind: "database_table" as const,
      signature: formatSignature(name, primaryKey, foreignKeys, approximateRows),
      snippet: formatSnippet(base),
    };
  });

  const artifactDir = join(dirname(resolve(dbPath)), "schema");
  const chunksPath = join(artifactDir, `${artifactPrefix(sourceDir, manifest)}-chunks.json`);
  const manifestPath = join(artifactDir, "manifest.json");
  const chunksJson = JSON.stringify(chunks, null, 2);
  const chunksHash = createHash("sha256").update(chunksJson).digest("hex");

  await mkdir(artifactDir, { recursive: true });
  await writeFile(chunksPath, `${chunksJson}\n`);
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    sourceDir,
    chunksFile: chunksPath,
    tableCount: chunks.length,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  return { artifactDir, chunksPath, manifestPath, manifest, chunks, chunksJson, chunksHash };
}
