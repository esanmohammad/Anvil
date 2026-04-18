// Shared types for pipeline stages

export interface AgentRunner {
  run(config: {
    persona: string;
    projectPrompt: string;
    userPrompt: string;
    workingDir: string;
    stage: string;
    model?: string;
    provider?: string;
  }): Promise<{ output: string; tokenEstimate: number }>;
}

export interface StageContext {
  runDir: string;
  project: string;
  feature: string;
  agentRunner: AgentRunner;
  projectYamlPath?: string;
  conventionsPath?: string;
  /** Workspace directory containing cloned repos for this project. */
  workspaceDir?: string;
  /** Map of repo name → local disk path for all repos in this project. */
  repoPaths?: Record<string, string>;
}

export interface StageOutput {
  artifact: string;       // the markdown content
  artifactName: string;   // e.g., "CLARIFICATION.md"
  tokenEstimate: number;
}
