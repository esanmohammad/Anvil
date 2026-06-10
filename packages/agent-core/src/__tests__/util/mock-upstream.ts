/**
 * MockUpstream — fault-injection harness for OpenAI-compatible SSE
 * adapters (v2 ADR §4.5).
 *
 * Spins up a real `node:http` server that answers
 * `POST /chat/completions` with an SSE stream assembled from a scripted
 * list of frames. The stream can be told to ABORT at a configurable
 * point — after N frames, or after a byte offset — to simulate a model
 * dying mid-output. Used to prove that the openrouter adapter surfaces
 * the partial assistant text it streamed before the cut (so the chain
 * walker can prefill the next model with it).
 *
 * Usage:
 *   const up = await MockUpstream.start();
 *   process.env.OPENROUTER_BASE_URL = up.baseUrl;       // adapter points here
 *   up.script([
 *     MockUpstream.textFrame('Hello, I am '),
 *     MockUpstream.textFrame('writing a function'),
 *     MockUpstream.usageFrame({ prompt_tokens: 10, completion_tokens: 5 }),
 *     MockUpstream.doneFrame(),
 *   ]);
 *   up.cutAfterFrames(2);                                // die after 2 frames
 *   // ... run the adapter, assert on what it streamed ...
 *   up.capturedRequests();                               // inspect what was POSTed
 *   await up.stop();
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/** A single SSE frame's JSON payload (the object after `data: `). */
export type SseFrame = Record<string, unknown> | '[DONE]';

interface CutPolicy {
  kind: 'none' | 'after-frames' | 'after-bytes';
  n: number;
}

export class MockUpstream {
  private server: Server;
  private frames: SseFrame[] = [];
  private cut: CutPolicy = { kind: 'none', n: 0 };
  private readonly captured: CapturedRequest[] = [];
  /** Per-request response delay (ms) before the first byte. */
  private firstByteDelayMs = 0;

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<MockUpstream> {
    const upstreamRef: { instance?: MockUpstream } = {};
    const server = createServer((req, res) => {
      upstreamRef.instance?.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const up = new MockUpstream(server);
    upstreamRef.instance = up;
    return up;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** Base URL the adapter should target (no trailing slash). */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Set the SSE frames the server will stream for the next request(s). */
  script(frames: SseFrame[]): this {
    this.frames = frames;
    return this;
  }

  /** Abort the stream after emitting `n` frames (simulates mid-stream death). */
  cutAfterFrames(n: number): this {
    this.cut = { kind: 'after-frames', n };
    return this;
  }

  /** Abort the stream after emitting `n` bytes of the SSE body. */
  cutAfterBytes(n: number): this {
    this.cut = { kind: 'after-bytes', n };
    return this;
  }

  /** No cut — stream the full script and close cleanly. */
  noCut(): this {
    this.cut = { kind: 'none', n: 0 };
    return this;
  }

  withFirstByteDelay(ms: number): this {
    this.firstByteDelayMs = ms;
    return this;
  }

  /** Every request the server received, in order. */
  capturedRequests(): CapturedRequest[] {
    return this.captured.slice();
  }

  /** The most recent captured request (or undefined). */
  lastRequest(): CapturedRequest | undefined {
    return this.captured[this.captured.length - 1];
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // ── Frame builders ──────────────────────────────────────────────────

  static textFrame(content: string): SseFrame {
    return {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
  }

  /** A tool_call delta. `argsChunk` is a piece of the JSON arg string —
   *  split a full args object across multiple frames to simulate
   *  streamed (and potentially truncated) tool_calls. */
  static toolCallFrame(opts: {
    index: number;
    id?: string;
    name?: string;
    argsChunk?: string;
  }): SseFrame {
    const fn: Record<string, unknown> = {};
    if (opts.name !== undefined) fn.name = opts.name;
    if (opts.argsChunk !== undefined) fn.arguments = opts.argsChunk;
    return {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: opts.index,
            ...(opts.id ? { id: opts.id } : {}),
            type: 'function',
            function: fn,
          }],
        },
        finish_reason: null,
      }],
    };
  }

  static finishFrame(reason = 'stop'): SseFrame {
    return {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
    };
  }

  static usageFrame(usage: Record<string, unknown>): SseFrame {
    return {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      choices: [],
      usage,
    };
  }

  static doneFrame(): SseFrame {
    return '[DONE]';
  }

  // ── Request handling ────────────────────────────────────────────────

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      let body: unknown;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      this.captured.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body,
      });
      void this.streamResponse(res);
    });
  }

  private async streamResponse(res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    if (this.firstByteDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.firstByteDelayMs));
    }

    let bytesWritten = 0;
    let framesWritten = 0;

    // Await each write's flush callback so the bytes actually reach the
    // client's socket buffer BEFORE we (optionally) reset the
    // connection. A synchronous `res.write(); res.destroy();` discards
    // the queued chunk entirely — the client would see an empty body +
    // reset, which is NOT the partial-delivery we want to simulate.
    const writeFlushed = (chunk: string): Promise<void> =>
      new Promise((resolve) => { res.write(chunk, () => resolve()); });

    // After delivering the cut frames, give the client's reader a beat
    // to drain the kernel buffer, THEN reset abnormally so undici
    // surfaces the already-received frames and throws on the next read.
    const resetAfterDrain = (): void => {
      setTimeout(() => res.destroy(), 25);
    };

    for (const frame of this.frames) {
      const line = frame === '[DONE]'
        ? 'data: [DONE]\n\n'
        : `data: ${JSON.stringify(frame)}\n\n`;

      // Byte-offset cut: write only up to the offset, then reset mid-frame.
      if (this.cut.kind === 'after-bytes') {
        const remaining = this.cut.n - bytesWritten;
        if (remaining <= 0) {
          resetAfterDrain();
          return;
        }
        if (line.length > remaining) {
          await writeFlushed(line.slice(0, remaining));
          resetAfterDrain();
          return;
        }
      }

      await writeFlushed(line);
      bytesWritten += line.length;
      framesWritten += 1;

      if (this.cut.kind === 'after-frames' && framesWritten >= this.cut.n) {
        // Frames are flushed; reset abnormally after a drain beat so the
        // client's reader.read() rejects mid-stream (real burn).
        resetAfterDrain();
        return;
      }
    }

    res.end();
  }
}
