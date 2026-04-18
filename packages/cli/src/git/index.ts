export { generateBranchName, isValidBranchName } from './branch-name.js';
export {
  execGit,
  createBranch,
  checkoutBranch,
  getDefaultBranch,
  branchExists,
} from './operations.js';
export { stageAll, stageFiles, commit, push, hasChanges } from './commit-push.js';
export {
  getStatus,
  getCurrentBranch,
  getCurrentSha,
  getDiff,
  isClean,
} from './status.js';
export type { FileChange, FileChangeStatus, GitStatus } from './status.js';
