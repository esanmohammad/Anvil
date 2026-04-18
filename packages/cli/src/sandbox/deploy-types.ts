// Deploy CLI integration types

export interface DeployConfig {
  /** The deploy CLI command to invoke (default: 'deploy') */
  command: string;
  /** Timeout in milliseconds for deploy commands */
  timeout: number;
  /** Whether to use --remote flag */
  remote: boolean;
}

export const DEFAULT_DEPLOY_CONFIG: DeployConfig = {
  command: 'deploy',
  timeout: 5 * 60_000,
  remote: true,
};

export interface PodStatus {
  name: string;
  ready: boolean;
  restarts: number;
  status: string;
}

export interface DeployEnvironment {
  namespace: string;
  ingressUrl: string;
  podStatuses: PodStatus[];
}

export interface DeployResult {
  success: boolean;
  environment?: DeployEnvironment;
  error?: DeployError;
  rawOutput: string;
}

export interface DeployError {
  code: string;
  message: string;
  retriable: boolean;
}
