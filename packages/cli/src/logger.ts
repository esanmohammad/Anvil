import pc from 'picocolors';

export function log(message: string): void {
  process.stderr.write(message + '\n');
}

export function info(message: string): void {
  process.stderr.write(pc.blue('ℹ') + ' ' + message + '\n');
}

export function success(message: string): void {
  process.stderr.write(pc.green('✓') + ' ' + message + '\n');
}

export function warn(message: string): void {
  process.stderr.write(pc.yellow('⚠') + ' ' + message + '\n');
}

export function error(message: string): void {
  process.stderr.write(pc.red('✗') + ' ' + message + '\n');
}
