/**
 * ReviewCalibrationStore — append-only NDJSON of resolution outcomes per
 * persona. Used to compute empirical accept-rates so over-confident personas
 * can be rescaled.
 */

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  CalibrationOutcome,
  CalibrationOutcomeEvent,
  CalibrationSnapshotBundle,
  PersonaSnapshot,
} from './review-calibration-types.js';

const ROTATE_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_WINDOW = 100;

export class ReviewCalibrationStore {
  constructor(private readonly anvilHome: string) {}

  private dir(project: string): string {
    const d = join(this.anvilHome, 'review-calibration', project);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
  }

  private logFile(project: string): string {
    return join(this.dir(project), 'outcomes.ndjson');
  }

  private rotateIfNeeded(project: string): void {
    const file = this.logFile(project);
    if (!existsSync(file)) return;
    try {
      const s = statSync(file);
      if (s.size > ROTATE_SIZE_BYTES) {
        renameSync(file, file + '.1');
      }
    } catch { /* non-fatal */ }
  }

  recordOutcome(project: string, event: Omit<CalibrationOutcomeEvent, 'at'> & { at?: string }): void {
    const at = event.at ?? new Date().toISOString();
    const line = JSON.stringify({ ...event, at }) + '\n';
    const file = this.logFile(project);
    this.rotateIfNeeded(project);
    appendFileSync(file, line, 'utf-8');
  }

  private readEvents(project: string): CalibrationOutcomeEvent[] {
    const file = this.logFile(project);
    if (!existsSync(file)) return [];
    const out: CalibrationOutcomeEvent[] = [];
    const text = readFileSync(file, 'utf-8');
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try {
        const obj = JSON.parse(raw) as CalibrationOutcomeEvent;
        if (typeof obj.personaId === 'string' && typeof obj.outcome === 'string') {
          out.push(obj);
        }
      } catch { /* skip malformed */ }
    }
    return out;
  }

  computeSnapshot(project: string, windowSize: number = DEFAULT_WINDOW): CalibrationSnapshotBundle {
    const events = this.readEvents(project);
    const byPersona = new Map<string, CalibrationOutcomeEvent[]>();
    for (const e of events) {
      const arr = byPersona.get(e.personaId) ?? [];
      arr.push(e);
      byPersona.set(e.personaId, arr);
    }

    const personas: PersonaSnapshot[] = [];
    for (const [personaId, all] of byPersona) {
      const window = all.slice(-windowSize);
      const accepted = window.filter((e) => e.outcome === 'accepted' || e.outcome === 'applied-patch').length;
      const dismissed = window.filter((e) => e.outcome === 'dismissed').length;
      const wontFix = window.filter((e) => e.outcome === 'wontFix').length;
      const decisionTotal = accepted + dismissed + wontFix;
      const empiricalAcceptRate = decisionTotal > 0 ? accepted / decisionTotal : 0;
      const statedSum = window.reduce((a, e) => a + (e.statedConfidence ?? 0), 0);
      const statedConfidenceMean = window.length > 0 ? statedSum / window.length : 0;
      personas.push({
        personaId,
        findingsSeen: window.length,
        accepted, dismissed, wontFix,
        empiricalAcceptRate,
        statedConfidenceMean,
        calibrationDelta: empiricalAcceptRate - statedConfidenceMean,
        lastUpdatedAt: window[window.length - 1]?.at ?? new Date().toISOString(),
      });
    }

    return {
      project,
      window: windowSize,
      personas: personas.sort((a, b) => b.findingsSeen - a.findingsSeen),
      computedAt: new Date().toISOString(),
    };
  }
}

export type CalibrationOutcomeKind = CalibrationOutcome;
