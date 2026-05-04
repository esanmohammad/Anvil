/**
 * Apply post-hoc calibration to findings using a CalibrationSnapshotBundle.
 * Personas with empirical accept rate < demoteBelowRate get findings demoted.
 */

import type { CalibrationSnapshotBundle, PersonaSnapshot } from './review-calibration-types.js';

const SEVERITY_LADDER = ['blocker', 'high', 'medium', 'low', 'info'] as const;
type Severity = (typeof SEVERITY_LADDER)[number];

function downgrade(s: string | undefined): Severity {
  const idx = SEVERITY_LADDER.indexOf(s as Severity);
  if (idx < 0) return 'info';
  return SEVERITY_LADDER[Math.min(idx + 1, SEVERITY_LADDER.length - 1)];
}

interface FindingShape {
  personaId?: string;
  severity?: string;
  statedConfidence?: number;
  calibratedConfidence?: number;
  demoted?: boolean;
}

export function applyCalibration(
  findings: unknown[],
  snapshot: CalibrationSnapshotBundle,
  opts: { demoteBelowRate?: number; minSamples?: number } = {},
): unknown[] {
  const demoteBelow = opts.demoteBelowRate ?? 0.3;
  const minSamples = opts.minSamples ?? 10;

  const byPersona = new Map<string, PersonaSnapshot>();
  for (const p of snapshot.personas) byPersona.set(p.personaId, p);

  return findings.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const f = raw as FindingShape;
    if (!f.personaId) return raw;
    const snap = byPersona.get(f.personaId);
    if (!snap || snap.findingsSeen < minSamples) return raw;

    const calibratedConfidence = snap.empiricalAcceptRate;
    if (calibratedConfidence < demoteBelow) {
      return {
        ...f,
        calibratedConfidence,
        demoted: true,
        severity: downgrade(f.severity),
      };
    }
    return { ...f, calibratedConfidence };
  });
}
