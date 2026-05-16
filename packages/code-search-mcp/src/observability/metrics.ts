/**
 * Minimal Prometheus metrics surface (P7).
 *
 * Zero-dep registry that produces the text-format `/metrics` body. Counter
 * + Histogram are enough to cover query rate, latency, embedding/LLM
 * spend, and error counts as documented in CODE-SEARCH-MCP-STANDALONE-PLAN
 * §3.8. The dashboard or prom-scraper can consume the output directly.
 */

export type LabelValues = Record<string, string | number>;

function formatLabels(labels?: LabelValues): string {
  if (!labels) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(labels)) {
    parts.push(`${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  }
  return parts.length ? `{${parts.join(',')}}` : '';
}

function labelKey(labels?: LabelValues): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join('|');
}

export class Counter {
  readonly name: string;
  readonly help: string;
  private buckets = new Map<string, { labels?: LabelValues; value: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels?: LabelValues, value: number = 1): void {
    const key = labelKey(labels);
    const existing = this.buckets.get(key);
    if (existing) existing.value += value;
    else this.buckets.set(key, { labels, value });
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} counter`);
    for (const { labels, value } of this.buckets.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

export class Gauge {
  readonly name: string;
  readonly help: string;
  private buckets = new Map<string, { labels?: LabelValues; value: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(value: number, labels?: LabelValues): void {
    this.buckets.set(labelKey(labels), { labels, value });
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} gauge`);
    for (const { labels, value } of this.buckets.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram {
  readonly name: string;
  readonly help: string;
  private readonly bucketBounds: number[];
  private buckets = new Map<string, {
    labels?: LabelValues;
    counts: number[];
    sum: number;
    total: number;
  }>();

  constructor(name: string, help: string, bucketBounds: number[] = DEFAULT_BUCKETS) {
    this.name = name;
    this.help = help;
    this.bucketBounds = bucketBounds;
  }

  observe(value: number, labels?: LabelValues): void {
    const key = labelKey(labels);
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = {
        labels,
        counts: new Array(this.bucketBounds.length).fill(0),
        sum: 0,
        total: 0,
      };
      this.buckets.set(key, entry);
    }
    for (let i = 0; i < this.bucketBounds.length; i++) {
      if (value <= this.bucketBounds[i]) entry.counts[i]++;
    }
    entry.sum += value;
    entry.total++;
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} histogram`);
    for (const entry of this.buckets.values()) {
      let cumulative = 0;
      for (let i = 0; i < this.bucketBounds.length; i++) {
        cumulative = entry.counts[i];
        const labels = { ...entry.labels, le: this.bucketBounds[i] };
        lines.push(`${this.name}_bucket${formatLabels(labels)} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket${formatLabels({ ...entry.labels, le: '+Inf' })} ${entry.total}`);
      lines.push(`${this.name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${formatLabels(entry.labels)} ${entry.total}`);
    }
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Process-wide registry
// ---------------------------------------------------------------------------

class Registry {
  private collectors = new Map<string, Counter | Gauge | Histogram>();

  register<T extends Counter | Gauge | Histogram>(metric: T): T {
    if (!this.collectors.has(metric.name)) this.collectors.set(metric.name, metric);
    return this.collectors.get(metric.name) as T;
  }

  render(): string {
    const parts: string[] = [];
    for (const c of this.collectors.values()) parts.push(c.render());
    return parts.join('\n') + '\n';
  }

  reset(): void {
    this.collectors.clear();
  }
}

export const registry = new Registry();

// ---------------------------------------------------------------------------
// Pre-declared metrics (importable everywhere)
// ---------------------------------------------------------------------------

export const metrics = {
  queriesTotal: registry.register(new Counter('code_search_queries_total', 'Total search queries by mode + repo.')),
  queryDuration: registry.register(new Histogram('code_search_query_duration_seconds', 'Query latency by mode.')),
  indexChunks: registry.register(new Gauge('code_search_index_chunks_total', 'Indexed chunks by repo.')),
  indexAge: registry.register(new Gauge('code_search_index_age_seconds', 'Seconds since last index by repo.')),
  embeddingCalls: registry.register(new Counter('code_search_embeddings_calls_total', 'Embedding API calls by provider.')),
  llmCalls: registry.register(new Counter('code_search_llm_calls_total', 'LLM API calls by phase.')),
  errors: registry.register(new Counter('code_search_errors_total', 'Errors by kind.')),
  rerankerCacheHits: registry.register(new Counter('code_search_reranker_cache_hits_total', 'Rerank cache lookups by outcome.')),
};
