/**
 * Glob-based domain matcher used by web_search/web_fetch allow/block lists.
 *
 * Supported patterns (intentionally minimal — full RFC-1738 globbing is
 * not the goal):
 *   - `example.com` — exact host match.
 *   - `*.example.com` — leftmost wildcard, matches any single subdomain.
 *   - `**.example.com` — matches the host and any subdomain.
 *   - `example.com/*` — host + any path.
 *   - `example.com/path/*` — host + path prefix.
 *
 * URL parsing: anything not parseable by `URL()` returns false. The
 * matcher is host-only by default; path prefixes are supported when
 * the pattern contains `/`.
 */

export function matchDomainGlob(url: string, pattern: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  const slash = pattern.indexOf('/');
  if (slash === -1) {
    return matchHost(host, pattern.toLowerCase());
  }

  const hostPattern = pattern.slice(0, slash).toLowerCase();
  const pathPattern = pattern.slice(slash);
  if (!matchHost(host, hostPattern)) return false;

  if (pathPattern === '/*' || pathPattern === '/**') return true;
  if (pathPattern.endsWith('/*')) {
    const prefix = pathPattern.slice(0, -1);
    return path.startsWith(prefix);
  }
  return path === pathPattern;
}

function matchHost(host: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  if (pattern.startsWith('**.')) {
    const suffix = pattern.slice(3);
    return host === suffix || host.endsWith('.' + suffix);
  }
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    if (!host.endsWith('.' + suffix)) return false;
    const head = host.slice(0, host.length - suffix.length - 1);
    return head.length > 0 && !head.includes('.');
  }
  return host === pattern;
}

export function filterByDomainAllowList<T extends { url: string }>(
  items: readonly T[],
  allow: readonly string[] | undefined,
): T[] {
  if (!allow || allow.length === 0) return items.slice();
  return items.filter((item) => allow.some((p) => matchDomainGlob(item.url, p)));
}

export function filterByDomainBlockList<T extends { url: string }>(
  items: readonly T[],
  block: readonly string[] | undefined,
): T[] {
  if (!block || block.length === 0) return items.slice();
  return items.filter((item) => !block.some((p) => matchDomainGlob(item.url, p)));
}
