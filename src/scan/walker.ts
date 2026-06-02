import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";
import { createHash } from "crypto";
import { detectLanguage } from "../chunk/languages.ts";

export interface ScannedFile {
  /** Absolute path */
  absPath: string;
  /** Path relative to the indexed root */
  relPath: string;
  language: string;
  hash: string;
  content: string;
}

/** Directory names to always ignore */
const ALWAYS_IGNORE = new Set([
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  ".next",
  "__pycache__",
  ".tox",
  ".venv",
  "venv",
  ".mypy_cache",
  ".cargo",
  ".rustup",
]);

const DEFAULT_PATH_EXCLUDES = [
  "**/src/generated/**",
];

const NESTED_SUBMODULE_EXCLUDES = new Set([
  "shared",
  "portfolio-admin-ts-models",
  "importer-models",
]);

interface IgnorePattern {
  raw: string;
  hasSlash: boolean;
  regex: RegExp;
}

function toSlash(path: string): string {
  return path.replace(/\\/g, "/");
}

function globToRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

/** Parse .gitignore-style patterns used by the scanner. */
function loadIgnorePatterns(content: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const clean = toSlash(trimmed).replace(/^\/+/, "").replace(/\/$/, "");
    if (!clean || clean.startsWith("!")) continue;
    patterns.push({
      raw: clean,
      hasSlash: clean.includes("/"),
      regex: globToRegex(clean),
    });
  }
  return patterns;
}

const DEFAULT_IGNORE_PATTERNS = DEFAULT_PATH_EXCLUDES.map((raw) => ({
  raw,
  hasSlash: true,
  regex: globToRegex(raw),
}));

function isNestedSubmoduleCopy(relPath: string): boolean {
  const parts = relPath.split("/").filter(Boolean);
  return parts.some((part, index) => index > 0 && NESTED_SUBMODULE_EXCLUDES.has(part));
}

function matchesIgnorePattern(relPath: string, patterns: IgnorePattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.hasSlash) {
      if (pattern.regex.test(relPath)) return true;
      if (pattern.raw.startsWith("**/") && globToRegex(pattern.raw.slice(3)).test(relPath)) return true;
      continue;
    }
    if (relPath.split("/").some(part => pattern.regex.test(part))) return true;
  }
  return false;
}

function isExcludedPath(relPath: string, patterns: IgnorePattern[]): boolean {
  const normalized = toSlash(relPath);
  return isNestedSubmoduleCopy(normalized) || matchesIgnorePattern(normalized, patterns);
}

/** Walk a directory tree and return source files with their content and hashes */
export async function scanDirectory(
  rootDir: string,
  languages?: string[],
): Promise<{ files: ScannedFile[]; errors: string[] }> {
  const files: ScannedFile[] = [];
  const errors: string[] = [];

  // Load .gitignore from root
  let ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
  try {
    const gitignore = await readFile(join(rootDir, ".gitignore"), "utf-8");
    ignorePatterns = ignorePatterns.concat(loadIgnorePatterns(gitignore));
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      errors.push(`cannot read .gitignore: ${err}`);
    }
    // ENOENT = no .gitignore, which is fine
  }

  const langFilter = languages ? new Set(languages) : null;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push(`cannot read ${dir}: ${err}`);
      return;
    }

    for (const entry of entries) {
      const name = entry.name;

      // Skip hidden files and always-ignored directories
      if (name.startsWith(".") && name !== ".") continue;
      const fullPath = join(dir, name);
      const relPath = toSlash(relative(rootDir, fullPath));

      if (ALWAYS_IGNORE.has(name)) continue;
      if (isExcludedPath(relPath, ignorePatterns)) continue;

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile() || entry.isSymbolicLink()) continue;

      // Check if this is a supported language
      const langConfig = detectLanguage(name);
      if (!langConfig) continue;
      if (langFilter && !langFilter.has(langConfig.name)) continue;

      try {
        const stats = await stat(fullPath);
        // Skip empty files and very large files (>1MB)
        if (stats.size === 0 || stats.size > 1_000_000) continue;

        const content = await readFile(fullPath, "utf-8");
        const hash = createHash("sha256").update(content).digest("hex");
        files.push({
          absPath: fullPath,
          relPath,
          language: langConfig.name,
          hash,
          content,
        });
      } catch (err) {
        errors.push(`cannot read ${fullPath}: ${err}`);
      }
    }
  }

  await walk(rootDir);
  return { files, errors };
}
