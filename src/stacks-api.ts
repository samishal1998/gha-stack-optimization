/**
 * Stack topology resolution against GitHub's native stacked-pull-request API.
 *
 * Isolated behind `TopologyProvider` so a v2 adapter for a non-native stacking
 * tool can be dropped in without touching topology.ts or verdict.ts.
 */
import * as core from '@actions/core';
import { context } from '@actions/github';
import type { Octokit, Repo } from './github.js';
import type { StackPR } from './types.js';

export interface ResolvedStack {
  /** Members ordered root -> head. */
  members: StackPR[];
  /** Stable identifier for the stack (used for concurrency grouping). */
  stackId: string;
  /** The stack's final target branch, not the PR's direct base. */
  targetBranch: string | null;
}

export interface TopologyProvider {
  /** Null when the PR is not part of a stack. */
  resolve(prNumber: number): Promise<ResolvedStack | null>;
}

/** Shape of the `stack` object GitHub attaches to a pull request resource. */
interface StackRef {
  id?: number;
  number: number;
  size?: number;
  position?: number;
  base?: { ref?: string | null } | null;
}

/** Shape of a stack resource from the Stacks API. */
interface StackResource {
  number: number;
  base?: { ref?: string | null } | null;
  pull_requests?: Array<{
    number: number;
    state?: string;
    draft?: boolean;
    merged_at?: string | null;
    head?: { ref?: string | null; sha?: string | null } | null;
  }> | null;
}

export class NativeStacksProvider implements TopologyProvider {
  constructor(
    private readonly octokit: Octokit,
    private readonly repo: Repo,
    private readonly checkpointLabel: string,
  ) {}

  async resolve(prNumber: number): Promise<ResolvedStack | null> {
    const stackNumber = await this.stackNumberFor(prNumber);
    if (stackNumber === null) return null;

    const stack = await this.fetchStack(stackNumber);
    if (!stack?.pull_requests || stack.pull_requests.length === 0) return null;

    const checkpoints = await this.checkpointPrs();
    const members: StackPR[] = stack.pull_requests.map((pr) => ({
      number: pr.number,
      sha: pr.head?.sha ?? '',
      headRef: pr.head?.ref ?? '',
      draft: pr.draft === true,
      state: pr.state === 'closed' ? 'closed' : 'open',
      merged: pr.merged_at != null,
      isCheckpoint: checkpoints.has(pr.number),
    }));

    return {
      members,
      stackId: String(stack.number),
      targetBranch: stack.base?.ref ?? null,
    };
  }

  /** The stack this PR belongs to, from the event payload if it is there. */
  private async stackNumberFor(prNumber: number): Promise<number | null> {
    const fromPayload = stackRefFromPayload(prNumber);
    if (fromPayload) return fromPayload.number;

    const { data } = await this.octokit.rest.pulls.get({
      ...this.repo,
      pull_number: prNumber,
    });
    const ref = (data as unknown as { stack?: StackRef | null }).stack;
    return ref?.number ?? null;
  }

  private async fetchStack(stackNumber: number): Promise<StackResource | null> {
    try {
      const { data } = await this.octokit.request(
        'GET /repos/{owner}/{repo}/stacks/{stack_number}',
        { ...this.repo, stack_number: stackNumber },
      );
      return data as StackResource;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        core.info(`Stack ${stackNumber} is no longer available (404).`);
        return null;
      }
      throw err;
    }
  }

  /**
   * PRs carrying the checkpoint label.
   *
   * This deliberately does not use `GET /repos/{owner}/{repo}/issues`, which can
   * filter by label server-side but requires the `issues: read` permission — a
   * scope this suite would otherwise never need, and one every consumer would
   * have to grant. Listing pull requests returns their labels and needs only
   * `pull-requests: read`, which is already required.
   *
   * Most repositories have fewer than a hundred open pull requests, so this is
   * one request; it degrades to one per hundred beyond that.
   */
  private async checkpointPrs(): Promise<Set<number>> {
    const open = await this.octokit.paginate(this.octokit.rest.pulls.list, {
      ...this.repo,
      state: 'open',
      per_page: 100,
    });
    return new Set(
      open
        .filter((pull) => pull.labels.some((label) => label.name === this.checkpointLabel))
        .map((pull) => pull.number),
    );
  }
}

/**
 * The `stack` object rides along on the `pull_request` in webhook payloads, so
 * a reconcile triggered by a PR event usually needs no extra request.
 */
function stackRefFromPayload(prNumber: number): StackRef | null {
  const pr = (context.payload as { pull_request?: { number: number; stack?: StackRef | null } })
    .pull_request;
  if (!pr || pr.number !== prNumber) return null;
  return pr.stack?.number != null ? pr.stack : null;
}
