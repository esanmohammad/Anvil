/**
 * Structured JSON logger (P7).
 *
 * Replaces `console.error` with one-JSON-line-per-event when
 * `telemetry.structuredLogs` is enabled. Falls back to passthrough text
 * mode otherwise so the dashboard's existing scrape-stderr pattern still
 * works during the migration.
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
      const comp = fields?.component ? `[${fields.component}]` : '';
      this.opts.write(`${level.toUpperCase()} ${comp} ${msg}`);
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
