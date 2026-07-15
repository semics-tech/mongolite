import { startMongoMemoryServer } from './mongoBackend.js';

let sharedUri: string | null = null;
let stopServer: (() => Promise<void>) | null = null;
let starting: Promise<string> | null = null;

/** Lazily starts a single shared MongoMemoryServer instance for the whole parity run. */
export async function getSharedMongoUri(): Promise<string> {
  if (sharedUri) return sharedUri;
  if (!starting) {
    starting = startMongoMemoryServer().then(({ uri, stop }) => {
      sharedUri = uri;
      stopServer = stop;
      return uri;
    });
  }
  return starting;
}

export async function stopSharedMongoMemoryServer(): Promise<void> {
  if (stopServer) {
    await stopServer();
    stopServer = null;
    sharedUri = null;
    starting = null;
  }
}
