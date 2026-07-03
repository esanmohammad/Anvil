/**
 * MongoDB BlobStorePort adapter (ADR §5.6 / P2).
 *
 * Small JSON/text artifacts (index_meta, profiles, deleted_files, PROJECT_GRAPH,
 * PROJECT_SUMMARY, per-repo graph.json/GRAPH_REPORT, profile_embeddings) live as
 * documents in one collection; large/binary artifacts (chunks.json NDJSON,
 * system_graph.sqlite) stream through GridFS. Project-scoped to mirror
 * FsBlobStore's per-project basePath: keys are project-relative POSIX paths and
 * never collide across projects (every doc/file carries the project).
 *
 * The `mongodb` driver is an optionalDependency — only the Mongo topology needs
 * it — so it's lazily imported with a clear error if absent, like better-sqlite3.
 */

import type { BlobStorePort } from './ports.js';

export interface MongoBlobConfig {
  uri: string;
  db: string;
  gridfsBucket?: string;
}

const BLOB_COLLECTION = 'kb_blobs';

/**
 * Module-level MongoClient pool keyed by connection URI. Every resolveStorage
 * call builds a fresh MongoBlobStore, and the per-call blob helpers run often
 * during indexing/serving — so without sharing, each would open its own client.
 * Instead all instances on the same URI reuse one pooled client. Closed via
 * {@link closeMongoClients} (daemon shutdown / test teardown).
 */
const clientCache = new Map<string, Promise<any>>();

function sharedClient(uri: string): Promise<any> {
  let p = clientCache.get(uri);
  if (!p) {
    p = (async () => {
      let mongodb: typeof import('mongodb');
      try {
        mongodb = await import('mongodb');
      } catch {
        throw new Error('mongodb is not installed. Install it with: npm install mongodb');
      }
      const client = new mongodb.MongoClient(uri);
      await client.connect();
      return client;
    })();
    // Evict a failed connection so the next call can retry instead of getting a
    // permanently-rejected cached promise.
    p.catch(() => { if (clientCache.get(uri) === p) clientCache.delete(uri); });
    clientCache.set(uri, p);
  }
  return p;
}

/** Close every pooled MongoDB client (daemon shutdown / test teardown). After
 *  this, a new MongoBlobStore op reconnects lazily. */
export async function closeMongoClients(): Promise<void> {
  const clients = [...clientCache.values()];
  clientCache.clear();
  await Promise.all(clients.map(async (p) => { try { (await p).close(); } catch { /* ignore */ } }));
}

interface Conn {
  coll: any;
  bucket: any;
  filesColl: any;
}

export class MongoBlobStore implements BlobStorePort {
  private connP?: Promise<Conn>;

  constructor(private readonly project: string, private readonly cfg: MongoBlobConfig) {}

  /** Resolve this instance's db handles off the shared client (cached per
   *  instance). The client itself is pooled module-wide by URI. */
  private conn(): Promise<Conn> {
    if (!this.connP) {
      this.connP = (async () => {
        const client = await sharedClient(this.cfg.uri); // friendly error if driver absent
        const mongodb = await import('mongodb'); // cached after sharedClient's import
        const bucketName = this.cfg.gridfsBucket ?? 'kb_files';
        const db = client.db(this.cfg.db);
        const coll = db.collection(BLOB_COLLECTION);
        await coll.createIndex({ project: 1, key: 1 }, { unique: true });
        const bucket = new mongodb.GridFSBucket(db, { bucketName });
        const filesColl = db.collection(`${bucketName}.files`);
        return { coll, bucket, filesColl };
      })();
    }
    return this.connP;
  }

  /** GridFS filename for a project-relative key. */
  private fname(key: string): string {
    return `${this.project}/${key}`;
  }

  // ── JSON / text → collection ────────────────────────────────────────────
  async getJson<T>(key: string): Promise<T | null> {
    const { coll } = await this.conn();
    const doc = await coll.findOne({ project: this.project, key });
    return doc ? (JSON.parse(doc.data as string) as T) : null;
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.putDoc(key, 'json', JSON.stringify(value));
  }

  async getText(key: string): Promise<string | null> {
    const { coll } = await this.conn();
    const doc = await coll.findOne({ project: this.project, key });
    return doc ? (doc.data as string) : null;
  }

  async putText(key: string, text: string): Promise<void> {
    await this.putDoc(key, 'text', text);
  }

  private async putDoc(key: string, kind: 'json' | 'text', data: string): Promise<void> {
    const { coll } = await this.conn();
    await coll.replaceOne(
      { project: this.project, key },
      { project: this.project, key, kind, data },
      { upsert: true },
    );
  }

  // ── existence / delete / list → both stores ─────────────────────────────
  async exists(key: string): Promise<boolean> {
    const { coll, filesColl } = await this.conn();
    if (await coll.findOne({ project: this.project, key }, { projection: { _id: 1 } })) return true;
    return (await filesColl.findOne({ filename: this.fname(key) }, { projection: { _id: 1 } })) != null;
  }

  async delete(key: string): Promise<void> {
    const { coll } = await this.conn();
    await coll.deleteOne({ project: this.project, key });
    await this.gridfsDelete(this.fname(key));
  }

  async deletePrefix(prefix: string): Promise<void> {
    const { coll, filesColl, bucket } = await this.conn();
    await coll.deleteMany({ project: this.project, key: { $regex: prefixRegex(prefix) } });
    const frx = `^${escapeRegex(this.fname(prefix))}(/|$)`;
    const cursor = filesColl.find({ filename: { $regex: frx } }, { projection: { _id: 1 } });
    for await (const f of cursor) {
      try { await bucket.delete(f._id); } catch { /* concurrent delete — ignore */ }
    }
  }

  async list(prefix: string): Promise<string[]> {
    const { coll, filesColl } = await this.conn();
    const out = new Set<string>();
    const collFilter = prefix
      ? { project: this.project, key: { $regex: prefixRegex(prefix) } }
      : { project: this.project };
    for await (const d of coll.find(collFilter, { projection: { key: 1 } })) out.add(d.key as string);
    const fileFilter = prefix
      ? { filename: { $regex: `^${escapeRegex(this.fname(prefix))}(/|$)` } }
      : { filename: { $regex: `^${escapeRegex(this.project + '/')}` } };
    for await (const f of filesColl.find(fileFilter, { projection: { filename: 1 } })) {
      out.add((f.filename as string).slice(this.project.length + 1));
    }
    return [...out];
  }

  // ── bytes / NDJSON → GridFS ─────────────────────────────────────────────
  async getBytes(key: string, opts?: { toFile?: string }): Promise<Buffer | string | null> {
    const { bucket, filesColl } = await this.conn();
    const fname = this.fname(key);
    if (!(await filesColl.findOne({ filename: fname }, { projection: { _id: 1 } }))) return null;
    if (opts?.toFile) {
      const { createWriteStream, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      const { pipeline } = await import('node:stream/promises');
      mkdirSync(dirname(opts.toFile), { recursive: true });
      await pipeline(bucket.openDownloadStreamByName(fname), createWriteStream(opts.toFile));
      return opts.toFile;
    }
    const parts: Buffer[] = [];
    for await (const c of bucket.openDownloadStreamByName(fname)) parts.push(c as Buffer);
    return Buffer.concat(parts);
  }

  async putBytes(key: string, data: Buffer | string): Promise<void> {
    const fname = this.fname(key);
    await this.gridfsDelete(fname); // overwrite semantics (mirror FsBlobStore)
    const { bucket } = await this.conn();
    if (typeof data === 'string') {
      // Contract: a string is a local source-file path to copy in.
      const { createReadStream } = await import('node:fs');
      const { pipeline } = await import('node:stream/promises');
      await pipeline(createReadStream(data), bucket.openUploadStream(fname));
    } else {
      const up = bucket.openUploadStream(fname);
      const done = onFinish(up);
      up.end(data);
      await done;
    }
  }

  async putNdjson(key: string, source: AsyncIterable<unknown> | Iterable<unknown>): Promise<void> {
    const fname = this.fname(key);
    await this.gridfsDelete(fname);
    const { bucket } = await this.conn();
    const up = bucket.openUploadStream(fname);
    const done = onFinish(up);
    try {
      for await (const item of source) {
        if (!up.write(JSON.stringify(item) + '\n')) {
          await new Promise<void>((res) => up.once('drain', () => res()));
        }
      }
    } finally {
      up.end();
    }
    await done;
  }

  async *iterateNdjson<T>(key: string): AsyncGenerator<T> {
    const { bucket, filesColl } = await this.conn();
    const fname = this.fname(key);
    if (!(await filesColl.findOne({ filename: fname }, { projection: { _id: 1 } }))) return;
    const dl = bucket.openDownloadStreamByName(fname);
    dl.setEncoding('utf-8');
    let buffered = '';
    let sawFirst = false;
    let arrayMode = false;
    for await (const piece of dl) {
      buffered += piece as string;
      if (!sawFirst) {
        const trimmed = buffered.trimStart();
        if (trimmed.length > 0) { sawFirst = true; arrayMode = trimmed[0] === '['; }
      }
      if (arrayMode) continue; // legacy single-array file: accumulate, parse at end
      let nl = buffered.indexOf('\n');
      while (nl >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line.trim().length > 0) yield JSON.parse(line) as T;
        nl = buffered.indexOf('\n');
      }
    }
    if (arrayMode) {
      for (const c of JSON.parse(buffered) as T[]) yield c;
    } else if (buffered.trim().length > 0) {
      yield JSON.parse(buffered) as T;
    }
  }

  private async gridfsDelete(fname: string): Promise<void> {
    const { bucket, filesColl } = await this.conn();
    const cursor = filesColl.find({ filename: fname }, { projection: { _id: 1 } });
    for await (const f of cursor) {
      try { await bucket.delete(f._id); } catch { /* already gone — ignore */ }
    }
  }
}

/** Regex matching a key equal to `prefix` OR nested under `prefix/` (mirrors
 *  FsBlobStore's dir-or-file list/delete semantics). */
function prefixRegex(prefix: string): string {
  return `^${escapeRegex(prefix)}(/|$)`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function onFinish(stream: { on(ev: string, cb: (...a: any[]) => void): void }): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
}
