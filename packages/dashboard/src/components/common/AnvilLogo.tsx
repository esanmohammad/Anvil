import React from 'react';

export interface AnvilLogoProps {
  size?: number;
  /** Solid fill colour. Defaults to currentColor so the wordmark
   *  inherits from a parent <span> with `color: var(--accent)`. */
  color?: string;
}

/**
 * Anvil logomark — chunky geometric anvil silhouette. Replaces the
 * lucide <Anvil> stroke icon (which reads as a thin elegant line —
 * the Apple/Vercel default we're moving away from). Solid fills,
 * orthogonal edges, no anti-aliased curves.
 */
export function AnvilLogo({ size = 18, color }: AnvilLogoProps) {
  const fill = color ?? 'currentColor';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Top face — slightly trapezoidal slab */}
      <path d="M3 6h18v3H3z" fill={fill} />
      {/* Horn — triangular tip on the left */}
      <path d="M0 6l3 0v3l-3 0z" fill={fill} opacity="0.85" />
      {/* Waist + base */}
      <path d="M6 9h12v4H6z" fill={fill} opacity="0.92" />
      <path d="M4 13h16v3H4z" fill={fill} />
      {/* Plinth shadow */}
      <path d="M2 16h20v2H2z" fill={fill} opacity="0.7" />
      {/* Base feet */}
      <path d="M5 18h4v3H5z" fill={fill} opacity="0.85" />
      <path d="M15 18h4v3h-4z" fill={fill} opacity="0.85" />
    </svg>
  );
}

export default AnvilLogo;
