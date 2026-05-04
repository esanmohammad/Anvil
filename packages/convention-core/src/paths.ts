/**
 * Path injection point for convention storage. Callers provide concrete
 * directories so this package never depends on cli home helpers.
 *
 * Canonical layout:
 *   <conventionsDir>/global.md
 *   <conventionsDir>/<project>/conventions.md
 *   <conventionsDir>/<project>/rules.json
 *   <rulesDir>/<project>/generated.json    (legacy — read-only fallback)
 */
export interface ConventionPaths {
  /** Absolute path to the conventions root, e.g. `~/.anvil/conventions`. */
  conventionsDir: string;
  /** Absolute path to the rules subdir, e.g. `~/.anvil/conventions/rules`. */
  rulesDir: string;
}
