import { mkdir, rm, writeFile } from "fs/promises";
import { dirname, resolve } from "path";

type DbOpener<T> = () => Promise<T>;

const DEFAULT_RETRY_DELAYS_MS = [50, 100, 200, 300];

export function isTransientDbOpenError(error: unknown): boolean {
  const msg = String((error as Error)?.message ?? error).toLowerCase();
  return (
    msg.includes("database is locked") ||
    msg.includes("database busy") ||
    msg.includes("database lock") ||
    msg.includes("failed to open database") && msg.includes("wal") ||
    msg.includes("statfs shared wal coordination path") ||
    msg.includes("shared wal") && msg.includes("lock")
  );
}

export function isWalOrOpenLockError(error: unknown): boolean {
  const msg = String((error as Error)?.message ?? error).toLowerCase();
  return isTransientDbOpenError(error) || msg.includes("wal") || msg.includes("lock");
}

export function formatDbSafetyError(error: unknown, dbPath: string): Error {
  const message = String((error as Error)?.message ?? error);
  if (!isWalOrOpenLockError(error)) return error instanceof Error ? error : new Error(message);
  return new Error(
    `${message}\n\n` +
    `Codemogger DB access failed for ${dbPath}.\n` +
    `Close other Codemogger processes using this DB and retry. ` +
    `If no process holds the DB, remove sidecars only after checking ownership (*.db-wal, *.db-shm, *.db-tshm). ` +
    `If the DB still fails, rebuild the Codemogger DB.`
  );
}

export async function openDbWithRetry<T>(
  dbPath: string,
  opener: DbOpener<T>,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      return await opener();
    } catch (error) {
      lastError = error;
      if (!isTransientDbOpenError(error) || attempt === retryDelaysMs.length) {
        throw formatDbSafetyError(error, dbPath);
      }
      const delay = retryDelaysMs[attempt]!;
      if (delay > 0) await new Promise(resolveDelay => setTimeout(resolveDelay, delay));
    }
  }
  throw formatDbSafetyError(lastError, dbPath);
}

export function writerLockPath(dbPath: string): string {
  return `${resolve(dbPath)}.writer.lock`;
}

export async function withDbWriterLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = writerLockPath(dbPath);
  await mkdir(dirname(resolve(dbPath)), { recursive: true });
  try {
    await mkdir(lockPath);
    await writeFile(`${lockPath}/owner`, `pid=${process.pid}\ncreatedAt=${new Date().toISOString()}\n`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(
        `Another Codemogger writer is active for ${dbPath}. ` +
        `Index and schema index are single-writer operations; wait for it to finish and retry.`
      );
    }
    throw error;
  }

  try {
    return await fn();
  } catch (error) {
    throw formatDbSafetyError(error, dbPath);
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
