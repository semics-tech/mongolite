/**
 * A {@link SyncSink} that ships changes to a remote HTTP API instead of connecting to
 * MongoDB directly, for deployments where the local instance cannot reach the database.
 *
 * The API receives MongoDB-shaped commands and applies them on the client's behalf —
 * see `@semics-tech/mongolite/server` for a receiver that does exactly that.
 *
 * Version predicates travel with each operation and conflicts come back in the response,
 * so replication behaves the same over HTTP as it does over a direct connection: the
 * upstream stays the source of truth, and a concurrent writer is detected rather than
 * overwritten.
 */
import { buildWriteCommand } from './commands.js';
import {
  SYNC_PROTOCOL_VERSION,
  SYNC_CONTENT_TYPE,
  decodeBody,
  encodeBody,
  toWireOperation,
} from './protocol.js';
import type { SyncApplyResponse, SyncApplyRequest, SyncFetchResponse } from './protocol.js';
import type { SyncApplyResult, SyncIdMapping, SyncOperation, SyncSink } from './types.js';

/** The subset of the global `fetch` signature this sink relies on. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface HttpSinkOptions {
  /** Base URL of the remote API, e.g. `https://api.example.com`. */
  baseUrl: string;

  /** Target database name, included in the request path. */
  database: string;

  /** Path segment before the database. Defaults to `'sync'`. */
  pathPrefix?: string;

  /**
   * Headers to attach to every request, resolved per request so short-lived tokens can
   * be refreshed. Anything static belongs in {@link HttpSinkOptions.headers}.
   *
   * @example
   * ```ts
   * getAuthHeaders: async () => ({ Authorization: `Bearer ${await getAccessToken()}` })
   * ```
   */
  getAuthHeaders?: () => Promise<Record<string, string>> | Record<string, string>;

  /** Static headers sent with every request. */
  headers?: Record<string, string>;

  /**
   * Capture and replay `set-cookie`, for APIs that use a session cookie for affinity
   * after the first authenticated request. Defaults to `true`.
   */
  cookies?: boolean;

  /**
   * `fetch` implementation. Defaults to the global one (Node 18+).
   *
   * Supply your own to get interceptors, connection pooling or proxy support — for
   * example `ofetch`. Note that retries are handled by the replicator, so a fetch layer
   * configured to retry will compound with that rather than replace it.
   */
  fetch?: FetchLike;

  /** Per-request timeout in ms. Defaults to `30_000`. */
  timeoutMs?: number;

  /** See {@link SyncIdMapping}. Defaults to `'auto'`. */
  idMapping?: SyncIdMapping;

  /** Conditional writes against `_v`. Defaults to `true`. */
  versioning?: boolean;

  /**
   * Include the built MongoDB command alongside each operation. Defaults to `true`,
   * so a forwarding API can pass it straight through. Turn it off to halve payload
   * size when the receiver rebuilds commands anyway (which it does by default).
   */
  includeCommands?: boolean;

  /** Replicator name, sent for server-side logging. */
  replicator?: string;
}

export class HttpUpstreamSink implements SyncSink {
  readonly name = 'http';

  private readonly fetchImpl: FetchLike;
  private readonly idMapping: SyncIdMapping;
  private readonly versioning: boolean;
  private cookie: string | null = null;

  constructor(private readonly options: HttpSinkOptions) {
    if (!options.baseUrl) throw new Error('HttpUpstreamSink requires a `baseUrl`.');
    if (!options.database) throw new Error('HttpUpstreamSink requires a `database`.');

    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    if (!options.fetch && typeof globalFetch !== 'function') {
      throw new Error(
        'HttpUpstreamSink needs a `fetch` implementation. Node 18+ provides one globally; ' +
          'on older runtimes pass `fetch` explicitly.'
      );
    }

    this.fetchImpl = options.fetch ?? (globalFetch as FetchLike);
    this.idMapping = options.idMapping ?? 'auto';
    this.versioning = options.versioning ?? true;
  }

  async apply(operations: SyncOperation[]): Promise<SyncApplyResult> {
    const includeCommands = this.options.includeCommands ?? true;

    const request: SyncApplyRequest = {
      protocol: SYNC_PROTOCOL_VERSION,
      replicator: this.options.replicator,
      operations: operations.map((op) =>
        toWireOperation(
          op,
          includeCommands
            ? buildWriteCommand(op, { idMapping: this.idMapping, versioning: this.versioning })
            : undefined
        )
      ),
    };

    let response: SyncApplyResponse;
    try {
      response = await this.send<SyncApplyResponse>('_sync', request);
    } catch (err) {
      // A request the API rejects outright will be rejected again on every retry, so
      // it is reported as a per-operation failure — dead-lettered, not spun on. The
      // sink's contract is that throwing means "transient", and this is not that.
      if (err instanceof SyncRequestRejected) {
        return {
          applied: 0,
          failures: operations.map((_op, index) => ({
            index,
            message: err.message,
            code: err.status,
          })),
        };
      }
      throw err;
    }

    return {
      applied: response.applied ?? 0,
      failures: response.failures,
      conflicts: response.conflicts,
    };
  }

  async fetch(collection: string, documentIds: string[]): Promise<Record<string, unknown>[]> {
    if (documentIds.length === 0) return [];

    const response = await this.send<SyncFetchResponse>('_sync/fetch', {
      protocol: SYNC_PROTOCOL_VERSION,
      collection,
      documentIds,
    });

    return response.documents ?? [];
  }

  // ---------------------------------------------------------------- internals

  private endpoint(path: string): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const prefix = (this.options.pathPrefix ?? 'sync').replace(/^\/+|\/+$/g, '');
    return `${base}/${prefix}/${encodeURIComponent(this.options.database)}/${path}`;
  }

  private async requestHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'content-type': SYNC_CONTENT_TYPE,
      accept: SYNC_CONTENT_TYPE,
      ...this.options.headers,
      ...(this.options.getAuthHeaders ? await this.options.getAuthHeaders() : {}),
    };

    if (this.cookie && (this.options.cookies ?? true)) headers.cookie = this.cookie;

    return headers;
  }

  /**
   * Posts a body and decodes the reply.
   *
   * Retries are deliberately *not* handled here — the replicator already owns backoff,
   * outage buffering and checkpointing. This throws on anything retryable and lets it do
   * its job; throwing twice over would compound the delays.
   */
  private async send<T>(path: string, body: unknown): Promise<T> {
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(this.endpoint(path), {
        method: 'POST',
        headers: await this.requestHeaders(),
        body: encodeBody(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure, DNS, timeout — all transient as far as we can tell.
      throw new Error(
        `Sync request to ${this.endpoint(path)} failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      clearTimeout(timer);
    }

    if (this.options.cookies ?? true) {
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie;
    }

    const text = await response.text();

    if (!response.ok) {
      const detail = text.slice(0, 500);
      // 4xx means the request itself is wrong and will stay wrong; throwing would spin
      // forever. Surfacing it as a per-operation failure dead-letters the batch instead.
      // 408 and 429 are the exceptions — they explicitly invite a retry.
      const retryable =
        response.status >= 500 || response.status === 408 || response.status === 429;

      if (retryable) {
        throw new Error(`Sync request failed with ${response.status}: ${detail}`);
      }

      throw new SyncRequestRejected(
        `Sync request rejected with ${response.status}: ${detail}`,
        response.status
      );
    }

    return decodeBody<T>(text);
  }
}

/**
 * The remote API refused the request outright.
 *
 * Distinct from a transport failure: retrying will produce the same refusal, so the
 * batch is dead-lettered rather than retried.
 */
export class SyncRequestRejected extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'SyncRequestRejected';
  }
}
