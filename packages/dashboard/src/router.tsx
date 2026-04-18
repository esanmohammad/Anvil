import React from 'react';

/** Route definitions for the Anvil dashboard */
export interface RouteConfig {
  path: string;
  id: string;
  label: string;
  /** If true, show in sidebar primary group */
  primary?: boolean;
  /** If true, show in sidebar secondary group */
  secondary?: boolean;
  /** If true, feature is not yet functional — show "Coming Soon" and disable CTA */
  comingSoon?: boolean;
}

export const routes: RouteConfig[] = [
  { path: '/', id: 'home', label: 'Home', primary: true },
  { path: '/runs', id: 'runs', label: 'Active Runs', primary: true },
  { path: '/pr-board', id: 'pr-board', label: 'Pull Requests', primary: true },
  { path: '/review', id: 'review', label: 'Review', primary: true, comingSoon: true },
  { path: '/test-gen', id: 'test-gen', label: 'Test Gen', primary: true, comingSoon: true },
  { path: '/plan', id: 'plan', label: 'Plan', primary: true, comingSoon: true },
  { path: '/history', id: 'history', label: 'History', secondary: true },
  { path: '/insights', id: 'insights', label: 'Insights', secondary: true },
  { path: '/project', id: 'project', label: 'Project', secondary: true },
  { path: '/knowledge-graph', id: 'knowledge-graph', label: 'Knowledge Graph', secondary: true },

  { path: '/settings', id: 'settings', label: 'Settings', secondary: true },
];

/** Routes shown in the sidebar primary group */
export const primaryRoutes = routes.filter((r) => r.primary);

/** Routes shown in the sidebar secondary group */
export const secondaryRoutes = routes.filter((r) => r.secondary);

/** Legacy: navRoutes for backward compat */
export const navRoutes = routes.filter((r) => r.primary || r.secondary);

/**
 * Simple client-side router using hash-based navigation.
 */
export function useHashRouter() {
  const [hash, setHash] = React.useState(window.location.hash.slice(1) || '/');

  React.useEffect(() => {
    const handler = () => setHash(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const navigate = React.useCallback((path: string) => {
    window.location.hash = path;
  }, []);

  // Support parameterized routes like /run/:id
  const runMatch = hash.match(/^\/run\/(.+)$/);

  // Support legacy routes — redirect stats→insights, overview→project
  let effectiveHash = hash;
  if (hash === '/stats') effectiveHash = '/insights';
  if (hash === '/overview') effectiveHash = '/project';

  const currentRoute = runMatch
    ? { path: hash, id: 'run', label: 'Run' }
    : (routes.find((r) => r.path === effectiveHash) || routes[0]);
  const runId = runMatch ? runMatch[1] : null;

  return { currentPath: hash, currentRoute, navigate, routes, runId };
}

export default routes;
