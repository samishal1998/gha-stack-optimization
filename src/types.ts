/**
 * Shared data shapes. Everything here is plain data — no Octokit, no I/O — so
 * that topology.ts and verdict.ts stay unit-testable from fixtures.
 */

/** A pull request as it appears in a stack, ordered root -> head by the caller. */
export interface StackPR {
  number: number;
  /** Head SHA at resolution time. */
  sha: string;
  headRef: string;
  draft: boolean;
  state: 'open' | 'closed';
  merged: boolean;
  /** Carries the configured checkpoint label. */
  isCheckpoint: boolean;
}

/** One member of a segment, as exported on the `segment` output. */
export interface SegmentMember {
  pr: number;
  sha: string;
  is_authority: boolean;
}

/**
 * Why a PR is an authority. `non-draft-head` is the highest non-draft PR,
 * promoted under `skip-draft-head` so a WIP head cannot govern the mergeable
 * part of the stack.
 */
export type AuthorityRole = 'head' | 'checkpoint' | 'non-draft-head';

/** Resolved topology for one PR. Mirrors the `context` action's outputs. */
export interface StackContext {
  inStack: boolean;
  stackId: string | null;
  targetBranch: string | null;
  /** 0-indexed from root, over the active (open, unmerged) members. */
  position: number | null;
  /** Number of active members. */
  size: number;
  pr: number;
  sha: string | null;
  isHead: boolean;
  isRoot: boolean;
  isCheckpoint: boolean;
  isDraft: boolean;
  isAuthority: boolean;
  /** PR number whose verdict governs this PR. Null when nothing governs it. */
  authorityPr: number | null;
  authoritySha: string | null;
  /** Why the governing authority is one. Null when nothing governs this PR. */
  authorityRole: AuthorityRole | null;
  /** This PR's segment, ordered head-ward -> root-ward (authority first). */
  segment: SegmentMember[];
  /** All active PRs below this one, ordered root-ward. */
  ancestors: SegmentMember[];
  /** All active PRs above this one, ordered head-ward. */
  descendants: SegmentMember[];
  /** Full active topology, root -> head. */
  stack: SegmentMember[];
}

/** Conclusions GitHub can report on a completed check run or workflow run. */
export type RunConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'stale'
  | 'skipped';

/** Conclusions the gate is willing to write. */
export type GateConclusion = 'success' | 'failure' | 'neutral';

export type CheckStatus = 'queued' | 'in_progress' | 'completed';

/**
 * Where a gate check's verdict came from. Recorded in the check run's
 * `external_id` so a later run of the gate can tell whether a given SHA ever
 * had real CI of its own. Without this, a mirrored `success` is
 * indistinguishable from an earned one — which is what makes the
 * "PR left the stack after skipping CI" and "checkpoint added mid-flight"
 * cases unanswerable.
 */
export type VerdictSource = 'own-ci' | 'mirror' | 'hold';

export interface Provenance {
  v: 1;
  /** `own-ci` means this SHA ran real CI (as authority, or via an escape hatch). */
  src: VerdictSource;
  /** Authority PR governing this verdict, when mirrored. */
  auth: number | null;
  /** Authority head SHA at write time. */
  authSha: string | null;
  /** True when this SHA's CI ran because of an escape hatch, not authority status. */
  forced: boolean;
}

/** An existing gate check read back off a SHA. */
export interface GateCheckState {
  id: number;
  status: CheckStatus;
  conclusion: RunConclusion | null;
  detailsUrl: string | null;
  provenance: Provenance | null;
}

/** One row of a verdict plan: "post this check on this SHA". */
export interface PlanEntry {
  pr: number;
  sha: string;
  status: CheckStatus;
  conclusion: GateConclusion | null;
  reason: PlanReason;
  title: string;
  summary: string;
  details_url: string | null;
  provenance: Provenance;
}

export type PlanReason =
  | 'not-in-stack-own-ci'
  | 'authority-own-ci'
  | 'authority-republish'
  | 'mirrors-authority'
  | 'forced-run-failure'
  | 'awaiting-authority'
  | 'authority-needs-own-ci'
  | 'left-stack-needs-own-ci'
  | 'no-verdict-conclusion';

export type ShouldRunReason =
  | 'not-in-stack'
  | 'is-head'
  | 'is-checkpoint'
  | 'is-authority'
  | 'forced-by-label'
  | 'forced-by-path'
  | 'mirrors-authority';

/** Resolved configuration (action inputs merged over the repo config file). */
export interface ResolvedConfig {
  checkName: string;
  checkpointLabel: string;
  forceRunLabel: string;
  alwaysRunPaths: string[];
  propagateFailures: boolean;
  skipDraftHead: boolean;
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  checkName: 'stack-gate',
  checkpointLabel: 'stack-checkpoint',
  forceRunLabel: 'stack-ci-force',
  alwaysRunPaths: [],
  propagateFailures: true,
  skipDraftHead: true,
};
