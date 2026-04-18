const MAX_BRANCH_LENGTH = 100;

// Git branch name validation rules:
// - No spaces, .., ~, ^, :, \, ?, *, [
// - No control characters (ASCII 0-31, 127)
// - Cannot end with .lock or /
// - Cannot start with -
// - Cannot contain //
// eslint-disable-next-line no-control-regex
const ILLEGAL_BRANCH_CHARS = /[\s~^:?*[\]\\]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function isValidBranchName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (ILLEGAL_BRANCH_CHARS.test(name)) return false;
  if (CONTROL_CHARS.test(name)) return false;
  if (name.includes('..')) return false;
  if (name.includes('//')) return false;
  if (name.startsWith('-')) return false;
  if (name.endsWith('.lock')) return false;
  if (name.endsWith('/')) return false;
  if (name.startsWith('.')) return false;
  if (name.endsWith('.')) return false;
  if (name.includes('@{')) return false;
  return true;
}

function sanitize(segment: string): string {
  // Replace illegal characters with hyphens
  let result = segment
    .replace(ILLEGAL_BRANCH_CHARS, '-')
    .replace(CONTROL_CHARS, '-')
    .replace(/\.\./g, '-')
    .replace(/\/\//g, '/')
    .replace(/@\{/g, '-');
  // Remove leading dots or hyphens from segments
  result = result.replace(/^[.\-]+/, '');
  // Remove trailing dots
  result = result.replace(/\.+$/, '');
  return result;
}

export function generateBranchName(runId: string, featureSlug: string): string {
  const sanitizedRunId = sanitize(runId);
  const sanitizedSlug = sanitize(featureSlug);

  let name = `anvil/${sanitizedRunId}/${sanitizedSlug}`;

  // Truncate if too long
  if (name.length > MAX_BRANCH_LENGTH) {
    name = name.slice(0, MAX_BRANCH_LENGTH);
  }

  // Ensure it doesn't end with / or .lock after truncation
  while (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) {
    if (name.endsWith('.lock')) {
      name = name.slice(0, -5);
    } else {
      name = name.slice(0, -1);
    }
  }

  return name;
}
