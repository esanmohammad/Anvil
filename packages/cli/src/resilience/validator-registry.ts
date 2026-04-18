/**
 * ValidatorRegistry — maps pipeline stage names to output validators.
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface StageValidator {
  /** The stage name this validator applies to. */
  stageName: string;
  /** Validate stage output. */
  validate(output: string): ValidationResult;
}

export class ValidatorRegistry {
  private validators: Map<string, StageValidator> = new Map();

  /** Register a validator for a stage. */
  register(validator: StageValidator): void {
    this.validators.set(validator.stageName, validator);
  }

  /** Get validator for a stage. */
  get(stageName: string): StageValidator | undefined {
    return this.validators.get(stageName);
  }

  /** Validate output for a given stage. Returns null if no validator registered. */
  validate(stageName: string, output: string): ValidationResult | null {
    const validator = this.validators.get(stageName);
    if (!validator) return null;
    return validator.validate(output);
  }

  /** Check if a validator is registered for a stage. */
  has(stageName: string): boolean {
    return this.validators.has(stageName);
  }

  /** Get all registered stage names. */
  getRegisteredStages(): string[] {
    return Array.from(this.validators.keys());
  }

  /** Remove a validator. */
  unregister(stageName: string): boolean {
    return this.validators.delete(stageName);
  }
}
