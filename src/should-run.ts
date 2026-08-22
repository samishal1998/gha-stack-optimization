/**
 * The skip decision, and the escape hatches that override it.
 *
 * Shared by the `should-run` action and the gate: the gate re-derives whether a
 * PR's CI was forced so it can tell a real failure from a gated no-op.
 */
import { minimatch } from 'minimatch';
import type { Octokit, Repo } from './github.js';
import type { ResolvedConfig, ShouldRunReason, StackContext } from './types.js';

export interface HatchState {
  forcedByLabel: boolean;
  forcedByPath: boolean;
}

export const NO_HATCH: HatchState = { forcedByLabel: false, forcedByPath: false };

export interface Decision {
  shouldRun: boolean;
  reason: ShouldRunReason;
  /** True when CI runs because of an escape hatch rather than authority status. */
  forced: boolean;
}

/**
 * Run CI if the PR is not in a stack, if it is an authority, or if an escape
 * hatch applies. Otherwise it mirrors its authority and runs nothing.
 */
export function decide(ctx: StackContext, hatch: HatchState): Decision {
  if (!ctx.inStack) return { shouldRun: true, reason: 'not-in-stack', forced: false };
  if (ctx.isAuthority) {
    const reason: ShouldRunReason = ctx.isHead
      ? 'is-head'
      : ctx.isCheckpoint
        ? 'is-checkpoint'
        : 'is-authority';
    return { shouldRun: true, reason, forced: false };
  }
  if (hatch.forcedByLabel) return { shouldRun: true, reason: 'forced-by-label', forced: true };
  if (hatch.forcedByPath) return { shouldRun: true, reason: 'forced-by-path', forced: true };
  return { shouldRun: false, reason: 'mirrors-authority', forced: false };
}

/**
 * Evaluate the escape hatches for a PR.
 *
 * Only called for PRs that would otherwise skip, so the changed-files request
 * is not paid for on every run.
 */
export async function evaluateHatches(
  octokit: Octokit,
  repo: Repo,
  prNumber: number,
  config: ResolvedConfig,
): Promise<HatchState> {
  const forcedByLabel = await hasLabel(octokit, repo, prNumber, config.forceRunLabel);
  if (forcedByLabel) return { forcedByLabel: true, forcedByPath: false };

  if (config.alwaysRunPaths.length === 0) return NO_HATCH;
  const forcedByPath = await touchesPaths(octokit, repo, prNumber, config.alwaysRunPaths);
  return { forcedByLabel: false, forcedByPath };
}

async function hasLabel(
  octokit: Octokit,
  repo: Repo,
  prNumber: number,
  label: string,
): Promise<boolean> {
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, {
    ...repo,
    issue_number: prNumber,
    per_page: 100,
  });
  return labels.some((l) => l.name === label);
}

async function touchesPaths(
  octokit: Octokit,
  repo: Repo,
  prNumber: number,
  globs: readonly string[],
): Promise<boolean> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    ...repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return files.some((file) => matchesAny(file.filename, globs));
}

/** True if `path` matches any glob. Dotfiles are matched, as CI paths often are. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => minimatch(path, glob, { dot: true }));
}
