// ── Git 集成 TypeScript 类型定义 ────────────────────────────────────

export interface GitDetectResult {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  remote: string;
  hasUncommitted: boolean;
}

export type GitFileStatusType =
  | 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted';

export interface GitFileStatus {
  path: string;
  status: GitFileStatusType;
  staged: boolean;
}

export interface GitStatusResult {
  files: GitFileStatus[];
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  totalChanges: number;
  stagedCount: number;
  error?: string;
}

export interface GitDiffResult {
  diff: string;
  stat: string;
  binary: boolean;
  error?: string;
}

export interface GitCommitResult {
  status: string;
  commitHash: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  message?: string;
}

export interface GitLogCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  body: string;
}

export interface GitLogResult {
  commits: GitLogCommit[];
  hasMore: boolean;
}

export interface GitBranch {
  name: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface GitBranchesResult {
  current: string;
  local: GitBranch[];
  remote: { name: string }[];
}

export interface GitPushPullResult {
  status: string;
  output: string;
  message?: string;
}

export interface GitStashEntry {
  index: number;
  hash: string;
  message: string;
  date: string;
}

export interface GitStashListResult {
  stashes: GitStashEntry[];
}
