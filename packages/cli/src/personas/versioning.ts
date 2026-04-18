export function getPersonaVersion(content: string): string | null {
  const match = content.match(/<!--\s*ff-persona-version:\s*([\d.]+)\s*-->/);
  return match ? match[1] : null;
}

export function isUpgradeAvailable(installedContent: string, bundledContent: string): boolean {
  const installed = getPersonaVersion(installedContent) || '0.0.0';
  const bundled = getPersonaVersion(bundledContent) || '0.0.0';
  return compareVersions(bundled, installed) > 0;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
