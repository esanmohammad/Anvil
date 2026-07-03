/**
 * Storage-abstraction public surface (ADR §2). Consumers import the ports +
 * `resolveStorage` from here; the concrete adapters stay internal except
 * `FsBlobStore` (re-exported for tests / explicit local construction).
 */
export type {
  VectorStorePort,
  BlobStorePort,
  GraphStorePort,
  StorageBundle,
  IvfPqIndexConfig,
} from './ports.js';
export { FsBlobStore } from './fs-blob-store.js';
export { MongoBlobStore, closeMongoClients } from './mongo-blob-store.js';
export type { MongoBlobConfig } from './mongo-blob-store.js';
export { resolveStorage, getBlobStore, findChunksInProject, lanceStorageOptions, lanceCacheBudget } from './resolve.js';
