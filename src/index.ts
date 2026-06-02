import { join, resolve } from "path";
import { mkdirSync, statSync, existsSync } from "fs";
import {
  Store,
  type SearchResult,
  type IndexedFile,
  type Codebase,
} from "./db/store.ts";
import { scanDirectory } from "./scan/walker.ts";
import { chunkFile } from "./chunk/treesitter.ts";
import { detectLanguage } from "./chunk/languages.ts";
import { preprocessQuery, type QueryMode } from "./search/query.ts";
import { rrfMerge } from "./search/rank.ts";
import { applyScope, type ScopeMode } from "./search/scope.ts";
import { buildSchemaSnapshotArtifacts } from "./schema/snapshot.ts";
import { withDbWriterLock } from "./db/safety.ts";
import type { Embedder } from "./embed/types.ts";

export type { SearchResult, IndexedFile, Codebase } from "./db/store.ts";
export type { CodeChunk } from "./chunk/types.ts";
export type { Embedder } from "./embed/types.ts";

export type SearchMode = "semantic" | "keyword" | "hybrid";

export interface SearchOptions {
  limit?: number;
  threshold?: number;
  includeSnippet?: boolean;
  mode?: SearchMode;
  scope?: string;
  scopeMode?: ScopeMode;
}

export type IndexPhase = "scan" | "hash" | "chunk" | "embed" | "cleanup" | "fts";

export interface IndexProgress {
  phase: IndexPhase;
  /** Current item within the phase (0 before work starts, 1-based during) */
  current: number;
  /** Total items in this phase (0 if unknown) */
  total: number;
}

export interface IndexOptions {
  languages?: string[];
  verbose?: boolean;
  onProgress?: (progress: IndexProgress) => void;
}

export interface IndexResult {
  files: number;
  chunks: number;
  embedded: number;
  skipped: number;
  removed: number;
  errors: string[];
  duration: number;
}

export interface SchemaIndexResult {
  tables: number;
  chunks: number;
  embedded: number;
  artifactDir: string;
  chunksPath: string;
  manifestPath: string;
  duration: number;
}

export interface CodeIndexOptions {
  dbPath: string;
  /** Embedding function - SDK users must provide their own */
  embedder: Embedder;
  /** Model name stored alongside embeddings (e.g. "all-MiniLM-L6-v2") */
  embeddingModel: string;
}

/** Compute the default DB path for a project directory: <dir>/.codemogger/index.db */
export function projectDbPath(dir: string): string {
  const dbDir = join(resolve(dir), ".codemogger");
  mkdirSync(dbDir, { recursive: true });
  return join(dbDir, "index.db");
}

export class CodeIndex {
  private store: Store | null = null;
  private dbPath: string;
  private embedder: Embedder;
  private embeddingModel: string;
  private searchVerified = false;

  constructor(opts: CodeIndexOptions) {
    this.dbPath = opts.dbPath;
    this.embedder = opts.embedder;
    this.embeddingModel = opts.embeddingModel;
  }

  private async getStore(): Promise<Store> {
    if (!this.store) {
      this.store = await Store.open(this.dbPath);
    }
    return this.store;
  }

  private buildEmbedText(s: {
    filePath: string;
    kind: string;
    name: string;
    signature: string;
    snippet: string;
  }): string {
    let text = s.filePath;
    if (s.kind && s.name) text += `: ${s.kind} ${s.name}`;
    else if (s.name) text += `: ${s.name}`;
    if (s.signature) text += `\n${s.signature}`;
    if (s.snippet) {
      const preview = s.snippet.slice(0, 500);
      text += `\n${preview}`;
    }
    return text;
  }

  /** Index a directory: scan files, chunk with tree-sitter, embed, store */
  async index(dir: string, opts?: IndexOptions): Promise<IndexResult> {
    return withDbWriterLock(this.dbPath, () => this.indexUnlocked(dir, opts));
  }

  private async indexUnlocked(dir: string, opts?: IndexOptions): Promise<IndexResult> {
    const start = performance.now();
    const store = await this.getStore();
    const rootDir = resolve(dir);

    // Get or create codebase entry
    const codebaseId = await store.getOrCreateCodebase(rootDir);
    await store.ensureFtsTable(codebaseId);

    const progressRaw = opts?.onProgress;
    let lastPct = -1;
    let lastPhase: IndexPhase | "" = "";
    function progress(p: IndexProgress) {
      if (!progressRaw) return;
      if (p.phase !== lastPhase) {
        lastPhase = p.phase;
        lastPct = -1;
      }
      if (p.total > 0) {
        const pct = Math.floor((p.current / p.total) * 100);
        if (pct === lastPct) return;
        lastPct = pct;
      }
      progressRaw(p);
    }

    // Phase 1: Scan directory for source files
    const t0 = performance.now();
    progress({ phase: "scan", current: 0, total: 0 });
    const { files, errors } = await scanDirectory(rootDir, opts?.languages);
    const scanTime = Math.round(performance.now() - t0);

    let filesProcessed = 0;
    let chunksCreated = 0;
    let skipped = 0;
    const activeFiles = new Set<string>();

    // Phase 2: Check hashes, chunk changed files, embed — pipelined in batches
    const t1 = performance.now();

    // Batch hash lookups: check which files changed (using absolute paths)
    const filesToProcess: typeof files = [];
    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi]!;
      activeFiles.add(file.absPath);
      const storedHash = await store.getFileHash(codebaseId, file.absPath);
      if (storedHash === file.hash) {
        skipped++;
      } else {
        filesToProcess.push(file);
      }
      progress({ phase: "hash", current: fi + 1, total: files.length });
    }

    // Process in streaming batches: chunk → write
    const FILE_BATCH = 200;
    const EMBED_BATCH = 64;
    let embedded = 0;

    for (
      let batchStart = 0;
      batchStart < filesToProcess.length;
      batchStart += FILE_BATCH
    ) {
      const batchFiles = filesToProcess.slice(
        batchStart,
        batchStart + FILE_BATCH,
      );

      // Chunk this batch
      const batchChunks: {
        filePath: string;
        fileHash: string;
        chunks: import("./chunk/types.ts").CodeChunk[];
      }[] = [];
      for (let bi = 0; bi < batchFiles.length; bi++) {
        const file = batchFiles[bi]!;
        const langConfig = detectLanguage(file.absPath);
        if (!langConfig) continue;
        try {
          const chunks = await chunkFile(
            file.absPath,
            file.content,
            file.hash,
            langConfig,
          );
          batchChunks.push({
            filePath: file.absPath,
            fileHash: file.hash,
            chunks,
          });
          filesProcessed++;
          chunksCreated += chunks.length;
        } catch (e: any) {
          errors.push(`${file.absPath}: ${e.message ?? String(e)}`);
        }
        progress({ phase: "chunk", current: batchStart + bi + 1, total: filesToProcess.length });
      }

      // Write chunks to DB, then incrementally populate FTS entries
      if (batchChunks.length > 0) {
        await store.batchUpsertAllFileChunks(codebaseId, batchChunks);
        await store.populateFtsForFiles(codebaseId, batchChunks.map(f => f.filePath));
      }
    }

    // Phase 3: Embed everything stale (in chunks to avoid OOM)
    const embedTotal = await store.countStaleEmbeddings(codebaseId, this.embeddingModel);
    while (true) {
      const stale = await store.getStaleEmbeddings(
        codebaseId,
        this.embeddingModel,
        1000,
      );
      if (stale.length === 0) break;

      for (let i = 0; i < stale.length; i += EMBED_BATCH) {
        const slice = stale.slice(i, i + EMBED_BATCH);
        const texts = slice.map(s => this.buildEmbedText(s));
        try {
          const vectors = await this.embedder(texts);
          await store.batchUpsertEmbeddings(
            slice.map((s, j) => ({
              chunkKey: s.chunkKey,
              embedding: vectors[j]!,
              modelName: this.embeddingModel,
            })),
          );
          embedded += vectors.length;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`embed batch ${Math.floor(i / EMBED_BATCH) + 1}: ${msg}`);
          process.stderr.write(`[codemogger] warning: embed batch failed: ${msg}\n`);
        }
        progress({ phase: "embed", current: embedded, total: embedTotal });
      }

      if (stale.length < 1000) break;
    }

    const chunkAndEmbedTime = Math.round(performance.now() - t1);

    // Phase 4: Remove chunks for deleted files
    progress({ phase: "cleanup", current: 0, total: 0 });
    const removed = await store.removeStaleFiles(codebaseId, activeFiles);

    // Phase 5: Optimize FTS index (entries populated incrementally above)
    progress({ phase: "fts", current: 0, total: 0 });
    const t3 = performance.now();
    await store.optimizeFts(codebaseId);
    const ftsTime = Math.round(performance.now() - t3);

    // Update codebase timestamp
    await store.touchCodebase(codebaseId);

    const duration = Math.round(performance.now() - start);

    // Log phase timing if verbose
    if (opts?.verbose) {
      console.log(
        `  scan: ${scanTime}ms, chunk+embed: ${chunkAndEmbedTime}ms (${embedded} chunks), fts: ${ftsTime}ms`,
      );
    }
    return {
      files: filesProcessed,
      chunks: chunksCreated,
      embedded,
      skipped,
      removed,
      errors,
      duration,
    };
  }

  async indexSchemaSnapshot(sourceDir: string): Promise<SchemaIndexResult> {
    return withDbWriterLock(this.dbPath, () => this.indexSchemaSnapshotUnlocked(sourceDir));
  }

  private async indexSchemaSnapshotUnlocked(sourceDir: string): Promise<SchemaIndexResult> {
    const start = performance.now();
    const artifacts = await buildSchemaSnapshotArtifacts(sourceDir, this.dbPath);
    const store = await this.getStore();
    const codebaseId = await store.getOrCreateCodebase(`schema:${resolve(sourceDir)}`, "database-schema");
    await store.ensureFtsTable(codebaseId);

    const chunks = artifacts.chunks.map((chunk, index) => ({
      chunkKey: `${artifacts.chunksPath}:${chunk.name}`,
      filePath: artifacts.chunksPath,
      language: "database_schema",
      kind: chunk.kind,
      name: chunk.name,
      signature: chunk.signature,
      snippet: chunk.snippet,
      startLine: index + 1,
      endLine: index + 1,
      fileHash: artifacts.chunksHash,
    }));

    await store.batchUpsertAllFileChunks(codebaseId, [{
      filePath: artifacts.chunksPath,
      fileHash: artifacts.chunksHash,
      chunks,
    }]);
    await store.populateFtsForFiles(codebaseId, [artifacts.chunksPath]);

    const stale = await store.getStaleEmbeddings(codebaseId, this.embeddingModel);
    let embedded = 0;
    for (let i = 0; i < stale.length; i += 64) {
      const slice = stale.slice(i, i + 64);
      const vectors = await this.embedder(slice.map(s => this.buildEmbedText(s)));
      await store.batchUpsertEmbeddings(
        slice.map((s, j) => ({
          chunkKey: s.chunkKey,
          embedding: vectors[j]!,
          modelName: this.embeddingModel,
        })),
      );
      embedded += vectors.length;
    }

    await store.optimizeFts(codebaseId);
    await store.touchCodebase(codebaseId);

    return {
      tables: artifacts.chunks.length,
      chunks: chunks.length,
      embedded,
      artifactDir: artifacts.artifactDir,
      chunksPath: artifacts.chunksPath,
      manifestPath: artifacts.manifestPath,
      duration: Math.round(performance.now() - start),
    };
  }

  /** Search for code chunks relevant to a query.
   *  - "semantic": natural language / conceptual queries (vector search, global)
   *  - "keyword": precise identifier or term lookup (FTS, queries all codebases)
   *  - "hybrid": combine both via reciprocal rank fusion
   */
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const store = await this.getStore();
    const limit = opts?.limit ?? 5;
    const threshold = opts?.threshold ?? 0.0;
    const includeSnippet = opts?.includeSnippet ?? false;
    const mode = opts?.mode ?? "semantic";
    const scope = opts?.scope?.trim();
    const scopeMode = opts?.scopeMode ?? "global";
    const filterScope = scope && scopeMode === "filter" ? scope : undefined;
    const candidateLimit = scope && scopeMode === "boost" ? Math.max(limit * 5, limit + 20) : limit;

    function finish(results: SearchResult[]): SearchResult[] {
      const scoped = applyScope(results, { scope, scopeMode }, limit);
      return threshold > 0 ? scoped.filter((r) => r.score >= threshold) : scoped;
    }

    // Verify the DB is in a readable state before searching
    await this.verifySearchable(store);

    if (mode === "semantic") {
      const [queryVec] = (await this.embedder([query])) as [number[]];
      const results = await store.vectorSearch(queryVec, candidateLimit, includeSnippet, filterScope);
      return finish(results);
    }

    // Keyword path: preprocess query for FTS
    const processed = preprocessQuery(query, "keywords");
    if (!processed.trim()) return [];

    const ftsResults = await store.ftsSearch(processed, candidateLimit, includeSnippet, filterScope);

    if (mode === "keyword") {
      return finish(ftsResults);
    }

    // Hybrid: combine keyword + semantic via RRF
    const [queryVec] = (await this.embedder([query])) as [number[]];
    const vecResults = await store.vectorSearch(
      queryVec,
      candidateLimit,
      includeSnippet,
      filterScope,
    );
    const merged = rrfMerge(ftsResults, vecResults, candidateLimit);
    return finish(merged);
  }

  /**
   * Verify the database is in a searchable state (once per instance).
   * Detects when the DB file is large but has no visible chunks
   * (e.g., WAL locked by another process, missing WAL file).
   */
  private async verifySearchable(store: Store): Promise<void> {
    if (this.searchVerified) return;
    this.searchVerified = true;

    // Quick check: does the DB file look like it should have data?
    if (!existsSync(this.dbPath)) return;
    const fileSize = statSync(this.dbPath).size;
    if (fileSize <= 1_000_000) return; // small/empty DB, nothing to verify

    // DB file is >1MB — verify at least one codebase has chunks
    const codebases = await store.listCodebases();
    if (codebases.length === 0) return; // no codebases registered, fine

    // Check if any codebase reports having chunks (from indexed_files, fast)
    const totalChunks = codebases.reduce((sum, c) => sum + c.chunkCount, 0);
    if (totalChunks > 0) return; // indexed_files metadata says we have chunks, good

    throw new Error(
      `Database file is ${(fileSize / 1e6).toFixed(0)}MB but contains no indexed chunks. ` +
        `The database may be locked by another process, or the WAL file may be missing or inaccessible.`,
    );
  }

  /** List all indexed files (optionally scoped to a directory/codebase) */
  async listFiles(): Promise<IndexedFile[]> {
    const store = await this.getStore();
    return store.listFiles();
  }

  /** List all codebases */
  async listCodebases(): Promise<Codebase[]> {
    const store = await this.getStore();
    return store.listCodebases();
  }

  /** Close the database connection */
  async close(): Promise<void> {
    if (this.store) {
      this.store.close();
      this.store = null;
    }
  }
}
