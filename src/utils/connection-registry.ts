/**
 * Process-wide registry of open SQLite handles, keyed by connection identity.
 *
 * Consumers frequently end up with several `MongoLite` instances pointing at the
 * same database file — a module-level client here, a background job there, each
 * calling `new MongoLite(path)` independently. Every one of those opens its own
 * SQLite connection, which turns same-process reads/writes into needless lock
 * contention and forces each consumer to hand-roll its own instance cache.
 *
 * When `shared` is enabled, adapters acquire their underlying handle through this
 * registry instead of opening one directly, so N adapter instances against the
 * same identity share a single connection. Each adapter still tracks its own
 * open/closed state; the handle is only really closed once the last holder
 * releases it (reference counting), so one consumer calling `close()` can't pull
 * the connection out from under another.
 *
 * Note this only dedupes connections *within a process*. Separate processes (e.g.
 * worker threads spawned as child processes, or a job runner forking workers)
 * each get their own registry and therefore their own connection — cross-process
 * contention is handled by WAL mode and `busy_timeout`, not by sharing.
 */

/**
 * Default `busy_timeout`, in milliseconds, applied to new connections.
 *
 * Lives here rather than in `db.ts` so the `node:sqlite` adapter can read it
 * without importing that module — `db.ts` pulls in `better-sqlite3`, which is an
 * optional dependency and may not be installed.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

interface RegistryEntry<THandle> {
  handle: THandle;
  refCount: number;
}

export class ConnectionRegistry<THandle> {
  private readonly entries = new Map<string, RegistryEntry<THandle>>();

  /**
   * Returns the handle registered for `key`, opening one via `open()` on first
   * use. Increments the reference count for existing entries.
   */
  public acquire(key: string, open: () => THandle): THandle {
    const existing = this.entries.get(key);
    if (existing) {
      existing.refCount++;
      return existing.handle;
    }

    const handle = open();
    this.entries.set(key, { handle, refCount: 1 });
    return handle;
  }

  /**
   * Drops one reference to `key`.
   * @returns `true` when the caller held the last reference and is therefore
   * responsible for closing the handle; `false` while other holders remain.
   */
  public release(key: string, handle: THandle): boolean {
    const entry = this.entries.get(key);

    // Untracked handle (never shared, or already fully released) — the caller
    // owns it outright and should close it.
    if (!entry || entry.handle !== handle) {
      return true;
    }

    entry.refCount--;
    if (entry.refCount > 0) {
      return false;
    }

    this.entries.delete(key);
    return true;
  }

  /** Live reference count for `key`; 0 when nothing holds it. */
  public refCount(key: string): number {
    return this.entries.get(key)?.refCount ?? 0;
  }

  /** Number of distinct shared handles currently open. */
  public get size(): number {
    return this.entries.size;
  }

  /**
   * Forgets every entry without closing the handles.
   * Intended for test isolation, not for production teardown.
   */
  public clear(): void {
    this.entries.clear();
  }
}

/**
 * Builds a stable registry key. Connections may only be shared when every
 * setting that affects the handle's behaviour matches, so each of these is part
 * of the identity rather than just the file path.
 */
export function buildConnectionKey(parts: {
  backend: string;
  filePath: string;
  readOnly: boolean;
  WAL: boolean;
  busyTimeout: number;
  verbose: boolean;
}): string {
  return JSON.stringify([
    parts.backend,
    parts.filePath,
    parts.readOnly,
    parts.WAL,
    parts.busyTimeout,
    parts.verbose,
  ]);
}

/**
 * Whether a database path is eligible for sharing.
 *
 * `:memory:` databases are private to their connection — two `:memory:` opens are
 * two unrelated databases, so sharing them would silently merge state that
 * callers expect to be isolated. Anonymous temp databases (empty path) behave the
 * same way.
 */
export function isShareablePath(filePath: string): boolean {
  const normalised = filePath.trim().toLowerCase();
  if (normalised === '' || normalised === ':memory:') {
    return false;
  }
  // file: URIs opt into sharing only when not explicitly in-memory.
  if (normalised.startsWith('file:') && normalised.includes('mode=memory')) {
    return false;
  }
  return true;
}
