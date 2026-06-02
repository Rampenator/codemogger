import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  formatDbSafetyError,
  openDbWithRetry,
  withDbWriterLock,
} from "../src/db/safety.ts";

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `codemogger-db-safety-${Date.now()}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("DB safety", () => {
  test("retries transient Turso open/lock errors and returns later success", async () => {
    let attempts = 0;
    const result = await openDbWithRetry("/tmp/test.db", async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("failed to open database test.db: I/O error (statfs shared WAL coordination path): entity not found");
      }
      return "ok";
    }, [0, 0]);

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("does not retry unrelated DB errors", async () => {
    let attempts = 0;
    await expect(openDbWithRetry("/tmp/test.db", async () => {
      attempts++;
      throw new Error("permission denied");
    }, [0, 0])).rejects.toThrow("permission denied");

    expect(attempts).toBe(1);
  });

  test("formats WAL/open-lock errors with actionable recovery guidance", () => {
    const error = formatDbSafetyError(new Error("shared WAL frame ids must increase monotonically"), "/tmp/test.db");

    expect(error.message).toContain("Close other Codemogger processes");
    expect(error.message).toContain("*.db-wal");
    expect(error.message).toContain("*.db-shm");
    expect(error.message).toContain("*.db-tshm");
    expect(error.message).toContain("rebuild the Codemogger DB");
  });

  test("writer lock blocks a second writer for the same DB and leaves DB sidecars alone", async () => {
    const dbPath = join(dir, "cache", "index.db");
    await mkdir(join(dir, "cache"), { recursive: true });
    await writeFile(`${dbPath}-wal`, "wal");
    await writeFile(`${dbPath}-shm`, "shm");
    await writeFile(`${dbPath}-tshm`, "tshm");

    await withDbWriterLock(dbPath, async () => {
      await expect(withDbWriterLock(dbPath, async () => "second")).rejects.toThrow("Another Codemogger writer is active");
    });

    expect(await readFile(`${dbPath}-wal`, "utf-8")).toBe("wal");
    expect(await readFile(`${dbPath}-shm`, "utf-8")).toBe("shm");
    expect(await readFile(`${dbPath}-tshm`, "utf-8")).toBe("tshm");
  });
});
