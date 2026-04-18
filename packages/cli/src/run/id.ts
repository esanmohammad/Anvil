// Run ID generation and parsing

const RUN_ID_PATTERN = /^run-(\d{8})-([a-z0-9]{4})$/;

export function generateRunId(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const date = `${y}${m}${d}`;

  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }

  return `run-${date}-${suffix}`;
}

export function parseRunId(id: string): { date: string; suffix: string } {
  const match = id.match(RUN_ID_PATTERN);
  if (!match) {
    throw new Error(`Invalid run ID format: ${id}`);
  }
  return { date: match[1], suffix: match[2] };
}

export function generateFeatureSlug(feature: string): string {
  let slug = feature.toLowerCase();
  // Replace spaces and special chars with hyphens
  slug = slug.replace(/[^a-z0-9-]/g, '-');
  // Collapse multiple hyphens
  slug = slug.replace(/-+/g, '-');
  // Strip leading/trailing hyphens
  slug = slug.replace(/^-+|-+$/g, '');
  // Truncate at 50 chars
  slug = slug.slice(0, 50);
  // Remove trailing hyphens after truncation
  slug = slug.replace(/-+$/, '');
  return slug;
}
