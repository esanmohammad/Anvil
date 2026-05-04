/**
 * Server-side tests are run via `tsc -p server/tsconfig.json && node --test`,
 * not Jest — the files use Node 20's native test runner. Ignore them here so
 * Jest's default-preset Babel parser doesn't false-flag TypeScript syntax.
 */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true, isolatedModules: true }],
  },
  testPathIgnorePatterns: [
    '/node_modules/',
    '/packages/dashboard/server/',
    '/packages/dashboard/src/',
    '/packages/cli/dist/',
    '/packages/cli/src/__fixtures__/',
    '/packages/core-pipeline/',
    '/packages/agent-core/',
    '/packages/memory-core/',
    '/packages/knowledge-core/',
    '/packages/cli/src/commands/test.ts',
  ],
};
