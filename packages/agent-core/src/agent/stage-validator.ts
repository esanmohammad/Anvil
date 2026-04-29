/**
 * Agent Process Manager — per-stage output validation gates.
 */

import type { ValidationResult } from './types.js';

type ValidatorFn = (output: string) => ValidationResult;

// ---------------------------------------------------------------------------
// Per-stage validators
// ---------------------------------------------------------------------------

function validateClarify(output: string): ValidationResult {
  const reasons: string[] = [];
  const hasQuestions =
    /##?\s*questions/i.test(output) || /\bQ[:\s]/i.test(output);
  const hasAnswers =
    /##?\s*answers/i.test(output) || /\bA[:\s]/i.test(output);
  if (!hasQuestions) reasons.push('Missing Q&A questions section');
  if (!hasAnswers) reasons.push('Missing Q&A answers section');
  return { valid: reasons.length === 0, reasons };
}

function validateRequirements(output: string): ValidationResult {
  const reasons: string[] = [];
  if (!/project/i.test(output)) reasons.push('No project references found');
  if (!/##?\s*success\s+criteria/i.test(output))
    reasons.push('Missing "## Success Criteria" section');
  return { valid: reasons.length === 0, reasons };
}

function validateProjectRequirements(output: string): ValidationResult {
  const reasons: string[] = [];
  if (!/repo/i.test(output)) reasons.push('No repository references found');
  return { valid: reasons.length === 0, reasons };
}

function validateSpecs(output: string): ValidationResult {
  const reasons: string[] = [];
  if (!/api|topic/i.test(output))
    reasons.push('No API or topic references found');
  return { valid: reasons.length === 0, reasons };
}

function validateTasks(output: string): ValidationResult {
  const reasons: string[] = [];
  if (!/##?\s*.+repo/i.test(output) && !/repo.*##/i.test(output))
    reasons.push('Tasks not grouped by repo headings');
  return { valid: reasons.length === 0, reasons };
}

function validateBuild(output: string): ValidationResult {
  const reasons: string[] = [];
  if (!/commit|git/i.test(output))
    reasons.push('No git commit references found');
  return { valid: reasons.length === 0, reasons };
}

function validateValidate(output: string): ValidationResult {
  const reasons: string[] = [];
  if (!/pass|fail/i.test(output))
    reasons.push('No pass/fail summary found');
  return { valid: reasons.length === 0, reasons };
}

function validateShip(output: string): ValidationResult {
  const reasons: string[] = [];
  if (!/https:\/\/github\.com/i.test(output))
    reasons.push('No PR URLs (https://github.com) found');
  return { valid: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Stage → validator mapping
// ---------------------------------------------------------------------------

const VALIDATORS: Record<string, ValidatorFn> = {
  clarify: validateClarify,
  requirements: validateRequirements,
  'project-requirements': validateProjectRequirements,
  specs: validateSpecs,
  tasks: validateTasks,
  build: validateBuild,
  validate: validateValidate,
  ship: validateShip,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class StageValidator {
  /**
   * Validate the output of a given stage.
   * Returns `{ valid: true, reasons: [] }` for unknown stages.
   */
  validateStageOutput(stage: string, output: string): ValidationResult {
    const fn = VALIDATORS[stage];
    if (!fn) return { valid: true, reasons: [] };
    return fn(output);
  }
}
