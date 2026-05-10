/**
 * Every user-facing string for the /policy page.
 *
 * Centralised so future copy edits are one-file changes — components
 * never inline strings, they import from `POLICY_COPY`.
 */

export const POLICY_COPY = {
  pageTitle: 'Policy',
  pageSubtitle: 'Decide when Anvil pauses for human review and how it spends.',
  statusOn: 'On',
  statusOff: 'Off',
  statusOnHint: 'Pauses fire after each gated stage.',
  statusOffHint: 'Runs go end-to-end with no review prompts.',
  selectProjectPrompt: 'Pick a project to manage its policy.',

  master: {
    label: 'Pause for human review',
    on: 'When on, Anvil stops between stages so you can approve, edit, or roll back before continuing.',
    off: 'When off, runs go end-to-end without any prompts.',
    confirmTurnOff: (project: string) =>
      `Turn off pauses for ${project}? Runs will go end-to-end with no review prompts. You can turn this back on any time.`,
  },

  pauseAfter: {
    title: 'When to pause',
    description: 'Pause after each of these stages completes:',
    plan: {
      label: 'Plan',
      hint: 'The agent has researched and written a plan. The cheapest moment to course-correct — undoing later costs more.',
      recommended: true,
    },
    implement: {
      label: 'Implement',
      hint: 'The agent has written code. Pausing here lets you spot regressions before tests run.',
    },
    review: {
      label: 'Review',
      hint: 'Validation pass complete. Pausing here lets you eyeball the agent\u2019s self-review before merging.',
    },
    test: {
      label: 'Test',
      hint: 'Tests have run. Pausing here lets you decide whether failures are real before triggering the fix loop.',
    },
    ship: {
      label: 'Ship',
      hint: 'Right before PR creation / deploy. Pausing here gives one last sanity check before the change leaves the agent\u2019s sandbox.',
    },
    emptyHint: 'Pauses are on but no stage triggers them — runs will not pause.',
  },

  autoApprove: {
    title: 'Skip the pause when\u2026',
    description: 'Auto-approve when BOTH conditions hold:',
    riskLabel: 'Risk is at or below',
    riskOptions: { low: 'Low', med: 'Medium', never: 'Always pause' },
    riskHint: 'Anvil scores every plan for risk. Low = config / docs / isolated. Medium = touches a shared package. High always pauses.',
    confidenceLabel: 'Confidence is at least',
    confidenceHint: 'The planner\u2019s self-rated confidence (0\u20131). Below this threshold, Anvil pauses for review even on low-risk plans.',
  },

  cost: {
    title: 'Cost limits',
    onBreachLabel: 'When a run hits a cap, Anvil',
    onBreachOptions: { ask: 'asks', 'auto-reject': 'stops', 'auto-approve': 'keeps going' },
    perRun: 'Per-run cap (USD)',
    perDay: 'Per-day cap (USD)',
    perStage: 'Per-stage caps (USD)',
    autoApproveBelow: 'Always approve overages below (USD)',
    autoApproveBelowHint: 'Tiny overshoots (typo-level retries) won\u2019t ping anyone.',
    grace: 'Grace window (seconds)',
    graceHint: 'Keep agents running this long while waiting on a cost decision so demos don\u2019t stall.',
  },

  qa: {
    title: 'Agent questions (Q&A)',
    enableLabel: 'Allow agents to ask clarifying questions',
    enableHint: 'When on, agents in Clarify, Requirements, and Specs can pause and ask you up to N questions before producing the artifact. When off, agents always produce the artifact in one shot \u2014 faster, but easier to drift.',
    maxLabel: 'Maximum questions per stage',
    maxHint: 'The agent picks the N most-relevant questions. It may also choose to ask none if it\u2019s already confident.',
    scope: 'Q&A applies to Clarify, Requirements, Repo Requirements, and Specs. Build, Test, Validate, and Ship don\u2019t use Q&A.',
  },

  notifications: {
    title: 'Notifications',
    slack: 'Slack',
    email: 'Email',
    timeoutLabel: 'Auto-action after no response (hours)',
    timeoutHint: 'If a reviewer doesn\u2019t decide in time, Anvil unblocks the run.',
  },

  paths: {
    title: 'Rules from yaml (read-only)',
    description: 'Path overrides loaded from pipeline-policy.yaml. To edit, open the file directly:',
    pathHint: '~/.anvil/projects/<slug>/pipeline-policy.yaml',
    empty: 'No path rules. Defaults above apply to every file.',
  },

  toast: {
    saved: 'Policy saved',
    saveFailed: 'Save failed',
    enabledOn: 'Pauses are now ON for this project',
    enabledOff: 'Pauses are now OFF for this project',
  },

  buttons: {
    cancel: 'Reset',
    save: 'Save changes',
    saving: 'Saving\u2026',
  },
};

export type PolicyCopy = typeof POLICY_COPY;
