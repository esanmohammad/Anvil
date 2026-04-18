import type { FFPlugin, PluginMapping } from './types.js';

export const PLUGIN_CATALOG: Record<string, FFPlugin> = {
  foundation: {
    name: 'foundation',
    version: '1.2.0',
    description: 'Core engineering tools: GitHub, Atlassian, Sentry, Notion, codebase search, ClickHouse logs',
    mcpServers: ['codebase-semantic-search', 'codebase-literal-search', 'clickhouse-logs'],
    capabilities: ['code-search', 'log-analysis', 'documentation', 'issue-tracking'],
  },
  dev: {
    name: 'dev',
    version: '1.0.0',
    description: 'Development tools: Naos design project, Chrome DevTools',
    mcpServers: ['naos-mcp'],
    capabilities: ['design-project', 'frontend-debugging'],
  },
  platform: {
    name: 'platform',
    version: '1.0.0',
    description: 'Platform tools: Cloudflare docs, Datadog',
    capabilities: ['infrastructure', 'monitoring', 'cdn'],
  },
  product: {
    name: 'product',
    version: '1.1.0',
    description: 'Product intelligence: competitive intelligence, user research, prioritization',
    capabilities: ['product-analysis', 'user-research', 'prioritization'],
  },
  qa: {
    name: 'qa',
    version: '1.0.0',
    description: 'QA knowledge and testing patterns',
    capabilities: ['test-patterns', 'quality-assurance'],
  },
  devops: {
    name: 'devops',
    version: '1.0.0',
    description: 'DevOps practices and CI/CD patterns',
    capabilities: ['ci-cd', 'deployment', 'infrastructure-as-code'],
  },
  security: {
    name: 'security',
    version: '1.0.0',
    description: 'Security knowledge and vulnerability patterns',
    capabilities: ['security-review', 'vulnerability-detection'],
  },
  ai: {
    name: 'ai',
    version: '1.0.0',
    description: 'AI/ML patterns and model integration',
    capabilities: ['ml-patterns', 'model-integration'],
  },
  ux: {
    name: 'ux',
    version: '1.0.0',
    description: 'UX patterns and design principles',
    capabilities: ['ux-patterns', 'accessibility'],
  },
  'tech-design': {
    name: 'tech-design',
    version: '1.0.0',
    description: 'Technical design patterns and architecture',
    capabilities: ['design-patterns', 'architecture'],
  },
  data: {
    name: 'data',
    version: '1.0.0',
    description: 'Data engineering patterns',
    capabilities: ['data-pipelines', 'analytics'],
  },
  'tech-support': {
    name: 'tech-support',
    version: '1.0.0',
    description: 'Technical support knowledge base',
    capabilities: ['troubleshooting', 'customer-issues'],
  },
};

export const DEFAULT_PLUGIN_MAPPING: PluginMapping = {
  clarifier: ['product', 'foundation', 'platform'],
  analyst: ['product', 'foundation'],
  architect: ['platform', 'foundation', 'dev', 'security'],
  lead: ['foundation', 'devops', 'qa'],
  engineer: ['dev', 'foundation', 'qa'],
  tester: ['qa', 'foundation', 'platform'],
};

export function getPlugin(name: string): FFPlugin | undefined {
  return PLUGIN_CATALOG[name];
}

export function getPersonaPlugins(persona: string): string[] {
  return DEFAULT_PLUGIN_MAPPING[persona] || [];
}
