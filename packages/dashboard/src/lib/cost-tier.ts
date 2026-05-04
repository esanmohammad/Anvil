// Pure helpers for mapping cost usage to severity tiers and formatting USD values.

export type CostTier = 'safe' | 'warning' | 'danger' | 'breach';

/** Pick a tier from a usage ratio.
 *  - `breach` when used >= limit
 *  - `danger` when used / limit >= 0.9
 *  - `warning` when used / limit >= alertAtFraction (default 0.6)
 *  - `safe` otherwise. When `limit` is 0/undefined → `safe`. */
export function costTier(
  used: number,
  limit: number | undefined,
  alertAtFraction = 0.6,
): CostTier {
  if (!limit || limit <= 0) return 'safe';
  if (used >= limit) return 'breach';
  const ratio = used / limit;
  if (ratio >= 0.9) return 'danger';
  if (ratio >= alertAtFraction) return 'warning';
  return 'safe';
}

/** CSS color var name for a tier (matches the design system already in use). */
export function tierColorVar(tier: CostTier): string {
  switch (tier) {
    case 'safe':
      return 'var(--color-success)';
    case 'warning':
      return 'var(--color-warning)';
    case 'danger':
    case 'breach':
      return 'var(--color-error)';
  }
}

/** Background tint, lower-alpha for use in progress bars / pills. */
export function tierBgVar(tier: CostTier): string {
  switch (tier) {
    case 'safe':
      return 'rgba(111,175,138,0.12)';   // eucalyptus, matches --color-success
    case 'warning':
      return 'rgba(212,162,74,0.12)';    // mustard, matches --color-warning
    case 'danger':
    case 'breach':
      return 'rgba(201,115,115,0.12)';   // rust, matches --color-error
  }
}

/** Format a USD number tightly: `$0.12`, `$3.40`, `$12`, `$120`. */
export function fmtUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '$0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 10) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${Math.round(abs)}`;
}
