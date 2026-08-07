/**
 * Finding things for the user so they do not have to type paths or remember
 * collection names: SQLite files on disk, and MongoLite-shaped tables inside
 * a database.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { IDatabaseAdapter } from '../db.js';

const DB_EXTENSIONS = ['.db', '.sqlite', '.sqlite3', '.db3'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
]);

export interface DatabaseCandidate {
  /** Absolute path to the file. */
  path: string;
  /** Path relative to the search root, for display. */
  relativePath: string;
  sizeBytes: number;
  modified: Date;
}

export interface FindDatabasesOptions {
  /** How many directory levels below the root to search. Default 2. */
  depth?: number;
  /** Stop after this many files. Default 50. */
  limit?: number;
}

/**
 * Walk `root` looking for SQLite-looking files, skipping the usual noisy
 * directories. Results are newest-first, since the file you just wrote is
 * almost always the one you want.
 */
export function findDatabaseFiles(
  root: string = process.cwd(),
  options: FindDatabasesOptions = {}
): DatabaseCandidate[] {
  const maxDepth = options.depth ?? 2;
  const limit = options.limit ?? 50;
  const found: DatabaseCandidate[] = [];

  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit || depth > maxDepth) return;

    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory - nothing useful to say about it.
    }

    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!DB_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
      // WAL/SHM siblings are not databases you can open directly.
      if (/-(wal|shm)$/.test(entry.name)) continue;

      try {
        const stats = statSync(full);
        found.push({
          path: full,
          relativePath: path.relative(root, full) || entry.name,
          sizeBytes: stats.size,
          modified: stats.mtime,
        });
      } catch {
        // File vanished between readdir and stat - ignore.
      }
    }
  };

  walk(root, 0);
  found.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return found;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}

export interface CollectionInfo {
  name: string;
  /** Number of documents (rows) in the collection. */
  count: number;
  /** False for tables that are not shaped like a MongoLite collection. */
  isMongoLite: boolean;
}

/**
 * List the tables in the database, flagging which ones look like MongoLite
 * collections (an `_id` column plus a `data` column). Foreign tables are still
 * reported so a user pointed at the wrong file gets a useful message rather
 * than an empty list.
 */
export async function listCollectionInfo(db: IDatabaseAdapter): Promise<CollectionInfo[]> {
  const tables = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );

  const infos: CollectionInfo[] = [];
  for (const { name } of tables) {
    let isMongoLite = false;
    try {
      const columns = await db.all<{ name: string }>(`PRAGMA table_info("${name}")`);
      const columnNames = new Set(columns.map((column) => column.name));
      isMongoLite = columnNames.has('_id') && columnNames.has('data');
    } catch {
      isMongoLite = false;
    }

    let count = 0;
    try {
      const row = await db.get<{ count: number }>(`SELECT COUNT(*) as count FROM "${name}"`);
      count = row?.count ?? 0;
    } catch {
      count = 0;
    }

    infos.push({ name, count, isMongoLite });
  }

  return infos;
}

/** Resolve a user-supplied database path, allowing `:memory:` and `~` shorthand. */
export function resolveDatabasePath(input: string): string {
  if (input === ':memory:') return input;
  const expanded = input.startsWith('~')
    ? path.join(process.env.HOME ?? '', input.slice(1))
    : input;
  return path.resolve(expanded);
}

export function databaseExists(dbPath: string): boolean {
  return dbPath === ':memory:' || existsSync(dbPath);
}
