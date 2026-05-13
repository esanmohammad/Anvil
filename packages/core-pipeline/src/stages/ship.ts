/**
 * Ship-stage prompt helpers + parsers owned by core-pipeline.
 *
 * Both cli's `createShipStep` and the dashboard's ship Step factory use
 * these helpers. There's no `runShipStage` free function here —
 * orchestration lives in the Step factory itself, where it has access
 * to its consumer's state (cost ledger, gh-auth pre-check, etc.).
 */

export interface ShipPromptInput {
  feature: string;
  featureSlug: string;
  repoNames: readonly string[];
  workspaceDir: string;
  actionType?: 'feature' | 'bugfix' | 'fix' | 'spike' | 'review';
  baseBranch?: string;
  /**
   * Phase D + G — plan binding for the run + compliance status. When
   * present, ship stamps `plan: <slug>@v<version> hash:<short>` on the
   * PR body and force-drafts when compliance < 100%.
   */
  planRef?: {
    slug: string;
    version: number;
    hashShort: string;
  };
  /** Pass-count / total / report-markdown for the build compliance check. */
  buildCompliance?: {
    passed: number;
    total: number;
    summary: string;
  };
  /** Same shape for the validate compliance check. */
  validateCompliance?: {
    passed: number;
    total: number;
    summary: string;
  };
}

const PR_URL_PATTERN = /https:\/\/github\.com\/[^\s"')]+\/pull\/\d+/g;
const SANDBOX_URL_LINE = /^SANDBOX_URL=(\S+)\s*$/m;

/**
 * Canonical ship user prompt — pushes the feature branch and opens a PR
 * per repo. Both cli and dashboard render this verbatim so shipping
 * behavior is byte-identical across consumers.
 */
export function buildShipUserPrompt(input: ShipPromptInput): string {
  const branch = `anvil/${input.featureSlug}`;
  const repoListStr = input.repoNames.length > 0 ? input.repoNames.join(', ') : '(workspace root)';
  const baseBranch = input.baseBranch ?? 'main';

  const prLabels = ['anvil'];
  const at = input.actionType ?? 'feature';
  if (at === 'bugfix' || at === 'fix') prLabels.push('bug');
  else if (at === 'spike' || at === 'review') prLabels.push(at);
  else prLabels.push('enhancement');
  const labelFlags = prLabels.map((l) => `--label "${l}"`).join(' ');

  // Phase G — force-draft when compliance < 100%. The ship agent reads
  // these directives + stamps the plan ref into the PR body.
  const buildPass = input.buildCompliance ? input.buildCompliance.passed === input.buildCompliance.total : true;
  const validatePass = input.validateCompliance ? input.validateCompliance.passed === input.validateCompliance.total : true;
  const requireDraft = !buildPass || !validatePass;

  const planStamp = input.planRef
    ? `plan: ${input.planRef.slug}@v${input.planRef.version} (hash: ${input.planRef.hashShort})`
    : '';
  const buildCompLine = input.buildCompliance
    ? `build compliance: ${input.buildCompliance.passed}/${input.buildCompliance.total}`
    : '';
  const validateCompLine = input.validateCompliance
    ? `validate compliance: ${input.validateCompliance.passed}/${input.validateCompliance.total}`
    : '';
  const prBodyHeader = [planStamp, buildCompLine, validateCompLine].filter(Boolean).join(' · ');

  const draftClause = requireDraft
    ? '5. Open a DRAFT PR — compliance is < 100%; use `--draft`. Add a "## Plan compliance" section to the body listing the unmet claims (paste BUILD_COMPLIANCE.md and PLAN_COMPLIANCE.md from the feature dir if present).'
    : `5. Open a PR — \`gh pr create --base "${baseBranch}" --head "${branch}" ${labelFlags}\`.\n   - If step 1 failed: add \`--draft\` and include "## Known Issues" in the body.\n   - Otherwise create a regular PR.`;

  return `Feature: "${input.feature}"
Repositories: ${repoListStr}
${prBodyHeader ? `\n${prBodyHeader}\n` : ''}
## Push feature branch + open PR

The code is on feature branch "${branch}". The build, lint, and tests have already run in earlier stages.

DO NOT explore the codebase. DO NOT \`read_file\` source files. DO NOT \`grep\` or \`find\` to "understand" the code. Your only job is the 5 git/gh commands below. Each numbered step is a single shell command. EXECUTE the commands via the Bash tool — do NOT print them as text.

For each repo with changes:
1. Final sanity build + lint — ONE bash command (e.g. \`go build ./... && go vet ./...\` or \`npm run build && npm run lint\`). Do not inspect output beyond exit code.
2. If step 1 failed, abort that repo (mark the eventual PR --draft with the failure in the body). Do NOT try to fix code here — fix happens in earlier stages.
3. Stage and commit — \`git add -A && git commit -m "[anvil] ${input.feature}${planStamp ? `\\n\\n${planStamp}` : ''}"\`. Skip if \`git status --porcelain\` is empty.
4. Push the feature branch — \`git push -u origin "${branch}"\`. REQUIRED — no exceptions.
${draftClause}

When writing the PR body, ALWAYS include the line "${prBodyHeader || '[anvil]'}" at the top.

Non-negotiable: every repo with a feature branch ends with a pushed branch and an open PR (URL in your output). Do NOT merge to ${baseBranch}. Do NOT skip step 4 or 5 — the run is a failure without the \`gh pr create\` URL in your output.`;
}

/** Pull GitHub PR URLs out of the agent's output. */
export function extractPrUrls(output: string): string[] {
  if (!output) return [];
  const matches = output.match(PR_URL_PATTERN);
  if (!matches) return [];
  return [...new Set(matches)];
}

/** Pull the SANDBOX_URL=<url> declaration from the agent's output. */
export function extractSandboxUrl(output: string): string | undefined {
  if (!output) return undefined;
  const match = output.match(SANDBOX_URL_LINE);
  return match?.[1];
}
