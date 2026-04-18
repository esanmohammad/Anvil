export interface FFPlugin {
  name: string;
  version: string;
  description: string;
  mcpServers?: string[];
  capabilities: string[];
}

export interface PluginMapping {
  [persona: string]: string[];
}
