/**
 * Agent Process Manager — output capture buffer.
 */

export class OutputBuffer {
  private chunks: string[] = [];

  /** Append data to the buffer. */
  append(data: string): void {
    this.chunks.push(data);
  }

  /** Return all captured output concatenated into one string. */
  getFullOutput(): string {
    return this.chunks.join('');
  }

  /** Rough token estimate: total characters / 4. */
  getTokenEstimate(): number {
    return Math.ceil(this.getFullOutput().length / 4);
  }

  /** Number of lines in the buffer. */
  getLineCount(): number {
    const full = this.getFullOutput();
    if (full.length === 0) return 0;
    return full.split('\n').length;
  }

  /** Clear the buffer. */
  clear(): void {
    this.chunks = [];
  }
}
