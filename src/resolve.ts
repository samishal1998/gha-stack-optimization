/**
 * The shared "resolve a PR's context" path used by every action, so the
 * topology and configuration are derived identically wherever they are needed.
 */
import * as core from '@actions/core';
import { resolveConfig } from './config.js';
import { getRepo, makeOctokit, resolveTargetPr } from './github.js';
import type { Octokit, Repo } from './github.js';
import { NativeStacksProvider } from './stacks-api.js';
import { computeContext } from './topology.js';
import type { ResolvedConfig, StackContext } from './types.js';

export interface Resolved {
  octokit: Octokit;
  repo: Repo;
  config: ResolvedConfig;
  ctx: StackContext;
  prNumber: number;
}

/**
 * Resolve everything an action needs: the PR under evaluation, the merged
 * configuration, and the stack topology around it.
 *
 * Returns null when no pull request can be identified, which is a normal
 * outcome for a `workflow_run` triggered by a push to a branch with no PR.
 */
export async function resolve(): Promise<Resolved | null> {
  const octokit = makeOctokit();
  const repo = getRepo();
  const prNumber = await resolveTargetPr(octokit, repo);
  if (prNumber === null) return null;
  const config = await resolveConfig(octokit, repo);
  const ctx = await resolveContext(octokit, repo, config, prNumber);
  return { octokit, repo, config, ctx, prNumber };
}

export async function resolveContext(
  octokit: Octokit,
  repo: Repo,
  config: ResolvedConfig,
  prNumber: number,
): Promise<StackContext> {
  const provider = new NativeStacksProvider(octokit, repo, config.checkpointLabel);
  const stack = await provider.resolve(prNumber);

  if (!stack) {
    // Not in a stack. We still need the PR's own head SHA to write a check to.
    const { data } = await octokit.rest.pulls.get({ ...repo, pull_number: prNumber });
    return computeContext({
      stack: [
        {
          number: prNumber,
          sha: data.head.sha,
          headRef: data.head.ref,
          draft: data.draft === true,
          state: data.state === 'closed' ? 'closed' : 'open',
          merged: data.merged === true,
          isCheckpoint: false,
        },
      ],
      prNumber,
      stackId: null,
      targetBranch: null,
      options: { skipDraftHead: config.skipDraftHead },
    });
  }

  return computeContext({
    stack: stack.members,
    prNumber,
    stackId: stack.stackId,
    targetBranch: stack.targetBranch,
    options: { skipDraftHead: config.skipDraftHead },
  });
}

/** Emit a StackContext as action outputs. */
export function setContextOutputs(ctx: StackContext): void {
  core.setOutput('in-stack', String(ctx.inStack));
  core.setOutput('stack-id', ctx.stackId ?? '');
  core.setOutput('target-branch', ctx.targetBranch ?? '');
  core.setOutput('position', ctx.position === null ? '' : String(ctx.position));
  core.setOutput('size', String(ctx.size));
  core.setOutput('sha', ctx.sha ?? '');
  core.setOutput('is-head', String(ctx.isHead));
  core.setOutput('is-root', String(ctx.isRoot));
  core.setOutput('is-checkpoint', String(ctx.isCheckpoint));
  core.setOutput('is-authority', String(ctx.isAuthority));
  core.setOutput('authority-pr', ctx.authorityPr === null ? '' : String(ctx.authorityPr));
  core.setOutput('authority-sha', ctx.authoritySha ?? '');
  core.setOutput('authority-role', ctx.authorityRole ?? '');
  core.setOutput('segment', JSON.stringify(ctx.segment));
  core.setOutput('ancestors', JSON.stringify(ctx.ancestors));
  core.setOutput('descendants', JSON.stringify(ctx.descendants));
  core.setOutput('stack', JSON.stringify(ctx.stack));
  core.setOutput('context', JSON.stringify(ctx));
}

/** Parse a context passed between actions, falling back to a fresh resolve. */
export function parseContextInput(raw: string): StackContext | null {
  if (!raw.trim()) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The `context` input is not a JSON object.');
  }
  const ctx = parsed as StackContext;
  if (typeof ctx.pr !== 'number' || typeof ctx.inStack !== 'boolean') {
    throw new Error('The `context` input is not a stack-gate context object.');
  }
  return ctx;
}
