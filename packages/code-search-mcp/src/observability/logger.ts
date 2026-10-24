/**
 * Structured JSON logger (P7).
 *
 * The server, daemon and CLI write their stderr log lines through this
 * logger: one JSON object per line when `telemetry.structuredLogs` is
 * enabled, otherwise passthrough text (`[component] msg`, the historical
 * stderr format that scrapers match on). Lines knowledge-core prints itself
 * are not routed through it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  msg: string;
  ts: string;
  component?: string;
  // Open fields — `error`, `query`, `durationMs`, etc.
  [key: string]: unknown;
}

export interface LoggerOpts {
  structured: boolean;
  /** Minimum level to emit (default 'info'). */
  level?: LogLevel;
  /** Override the underlying write target (defaults to stderr). */
  write?: (line: string) => void;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private readonly opts: Required<Pick<LoggerOpts, 'structured' | 'level'>> & {
    write: (line: string) => void;
  };

  constructor(opts: LoggerOpts) {
    this.opts = {
      structured: opts.structured,
      level: opts.level ?? 'info',
      write: opts.write ?? ((line) => process.stderr.write(line + '\n')),
    };
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.emit('debug', msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.emit('info', msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.emit('warn', msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.emit('error', msg, fields); }

  /** Bind a component name so every line carries it. */
  child(component: string): Logger {
    return new Logger({
      structured: this.opts.structured,
      level: this.opts.level,
      write: (line) => this.opts.write(line),
    }).withComponent(component);
  }

  /** Internal — return a logger that prefixes the component field. */
  private withComponent(component: string): Logger {
    const self = this;
    return new Proxy(self, {
      get(target, prop) {
        if (prop === 'emit') {
          return (level: LogLevel, msg: string, fields?: Record<string, unknown>) =>
            self.emit(level, msg, { component, ...fields });
        }
        return (target as never)[prop as keyof Logger];
      },
    }) as Logger;
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.opts.level]) return;
    if (this.opts.structured) {
      const entry: LogEntry = { level, msg, ts: new Date().toISOString(), ...fields };
      this.opts.write(JSON.stringify(entry));
    } else {
      this.opts.write(fields?.component ? `[${fields.component}] ${msg}` : msg);
    }
  }
}

let _default: Logger | null = null;

export function getLogger(): Logger {
  if (!_default) _default = new Logger({ structured: false });
  return _default;
}

export function configureLogger(opts: LoggerOpts): void {
  _default = new Logger(opts);
}

export type ComponentLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

/**
 * Logger bound to a component name that resolves the process-wide logger on
 * every call — safe to create at module load, before `configureLogger` runs.
 */
export function getComponentLogger(component: string): ComponentLogger {
  return {
    debug: (msg, fields) => getLogger().debug(msg, { component, ...fields }),
    info: (msg, fields) => getLogger().info(msg, { component, ...fields }),
    warn: (msg, fields) => getLogger().warn(msg, { component, ...fields }),
    error: (msg, fields) => getLogger().error(msg, { component, ...fields }),
  };
}
