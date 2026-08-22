/**
 * Pure stack topology: authorities and segments.
 *
 * No network, no Octokit. Given the ordered members of a stack and a target PR
 * number, decide who runs CI and whose verdict each PR mirrors.
 */
import type { AuthorityRole, SegmentMember, StackContext, StackPR } from './types.js';

export interface TopologyOptions {
  /**
   * When the head is a draft, also treat the highest non-draft PR as an
   * authority so a work-in-progress head cannot paint the whole stack red.
   */
  skipDraftHead: boolean;
}

/** A PR is active if it can still be merged into the stack's target. */
export function isActive(pr: StackPR): boolean {
  return pr.state === 'open' && !pr.merged;
}

function toMember(pr: StackPR, authorities: ReadonlySet<number>): SegmentMember {
  return { pr: pr.number, sha: pr.sha, is_authority: authorities.has(pr.number) };
}

/**
 * Authorities are the PRs that run real CI and establish a verdict:
 *
 *   - the stack head (always),
 *   - every checkpoint,
 *   - and, when `skipDraftHead` is set and the head is a draft, the highest
 *     non-draft PR.
 *
 * The last one generalises the PRD's `skip-draft-head` knob. Keeping the draft
 * head as an authority too means the drafts above still get a verdict from a
 * tree that actually contains their changes; the non-draft authority below them
 * shields the mergeable part of the stack from a WIP head.
 *
 * `active` must be ordered root -> head.
 */
export function computeAuthorities(active: readonly StackPR[], opts: TopologyOptions): Set<number> {
  const authorities = new Set<number>();
  if (active.length === 0) return authorities;

  const head = active[active.length - 1]!;
  authorities.add(head.number);

  for (const pr of active) {
    if (pr.isCheckpoint) authorities.add(pr.number);
  }

  if (opts.skipDraftHead && head.draft) {
    for (let i = active.length - 1; i >= 0; i--) {
      const pr = active[i]!;
      if (!pr.draft) {
        authorities.add(pr.number);
        break;
      }
    }
  }

  return authorities;
}

/**
 * The authority governing `index`: the nearest authority at or above it.
 *
 * The head is always an authority, so this never returns null for a non-empty
 * stack.
 */
function authorityIndexFor(
  active: readonly StackPR[],
  index: number,
  authorities: ReadonlySet<number>,
): number | null {
  for (let i = index; i < active.length; i++) {
    if (authorities.has(active[i]!.number)) return i;
  }
  return null;
}

/**
 * The segment owned by the authority at `authorityIndex`: the authority itself
 * plus every PR below it, down to (not including) the next authority below.
 *
 * Returned authority-first (head-ward -> root-ward), which is the order a
 * verdict is propagated in.
 */
export function segmentOf(
  active: readonly StackPR[],
  authorityIndex: number,
  authorities: ReadonlySet<number>,
): SegmentMember[] {
  const members: SegmentMember[] = [toMember(active[authorityIndex]!, authorities)];
  for (let i = authorityIndex - 1; i >= 0; i--) {
    const pr = active[i]!;
    if (authorities.has(pr.number)) break;
    members.push(toMember(pr, authorities));
  }
  return members;
}

/**
 * Why `authority` holds authority. Head wins over checkpoint for display: it is
 * the more fundamental reason, and a head may also carry the label.
 */
function roleOf(active: readonly StackPR[], authorityIndex: number): AuthorityRole {
  if (authorityIndex === active.length - 1) return 'head';
  if (active[authorityIndex]!.isCheckpoint) return 'checkpoint';
  return 'non-draft-head';
}

/** A PR that is not in a stack (or is the only member left of one). */
function standaloneContext(prNumber: number, sha: string | null): StackContext {
  return {
    inStack: false,
    stackId: null,
    targetBranch: null,
    position: null,
    size: sha === null ? 0 : 1,
    pr: prNumber,
    sha,
    isHead: false,
    isRoot: false,
    isCheckpoint: false,
    isDraft: false,
    isAuthority: false,
    authorityPr: null,
    authoritySha: null,
    authorityRole: null,
    segment: [],
    ancestors: [],
    descendants: [],
    stack: [],
  };
}

export interface ComputeContextInput {
  /** Stack members ordered root -> head. May include merged/closed PRs. */
  stack: readonly StackPR[];
  prNumber: number;
  stackId: string | null;
  targetBranch: string | null;
  options: TopologyOptions;
}

/**
 * Resolve one PR's position, authority and segment within its stack.
 *
 * Merged and closed members are dropped first: a merged parent is no longer
 * part of the gating problem, and dropping it is what makes "head PR merged"
 * resolve to "the next PR down is now the head" with no special case.
 *
 * A stack with one active member is reported as not-in-stack (PRD 14.3): with
 * nothing above or below it, there is nothing to mirror and it should simply
 * run its own CI.
 */
export function computeContext(input: ComputeContextInput): StackContext {
  const { stack, prNumber, stackId, targetBranch, options } = input;
  const active = stack.filter(isActive);
  const self = active.find((pr) => pr.number === prNumber);

  if (!self) {
    // The PR is closed/merged, or not a member at all.
    const known = stack.find((pr) => pr.number === prNumber);
    return standaloneContext(prNumber, known?.sha ?? null);
  }
  if (active.length <= 1) {
    return standaloneContext(prNumber, self.sha);
  }

  const authorities = computeAuthorities(active, options);
  const index = active.findIndex((pr) => pr.number === prNumber);
  const authIndex = authorityIndexFor(active, index, authorities);
  const authority = authIndex === null ? null : active[authIndex]!;

  return {
    inStack: true,
    stackId,
    targetBranch,
    position: index,
    size: active.length,
    pr: self.number,
    sha: self.sha,
    isHead: index === active.length - 1,
    isRoot: index === 0,
    isCheckpoint: self.isCheckpoint,
    isDraft: self.draft,
    isAuthority: authorities.has(self.number),
    authorityPr: authority?.number ?? null,
    authoritySha: authority?.sha ?? null,
    authorityRole: authIndex === null ? null : roleOf(active, authIndex),
    segment: authIndex === null ? [] : segmentOf(active, authIndex, authorities),
    ancestors: active
      .slice(0, index)
      .reverse()
      .map((pr) => toMember(pr, authorities)),
    descendants: active.slice(index + 1).map((pr) => toMember(pr, authorities)),
    stack: active.map((pr) => toMember(pr, authorities)),
  };
}
