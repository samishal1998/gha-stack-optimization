/**
 * `stack-gate/verdict` — compute what should be reported, writing nothing.
 *
 * Splitting computation from mutation is what makes the decision surface
 * testable and gives `propagate` a dry-run mode worth having.
 */
import * as core from '@actions/core';
import { ChecksClient } from '../checks.js';
import { resolveConfig } from '../config.js';
import { fail, getRepo, makeOctokit, optionalString, resolveTargetPr } from '../github.js';
import { parseContextInput, resolveContext } from '../resolve.js';
import { NO_HATCH, decide, evaluateHatches } from '../should-run.js';
import { computeVerdict, type Trigger } from '../verdict.js';
import type { RunConclusion } from '../types.js';

async function main(): Promise<void> {
  const octokit = makeOctokit();
  const repo = getRepo();
  const prNumber = await resolveTargetPr(octokit, repo);
  if (prNumber === null) {
    // No PR behind this run. Nothing is gated, so emit an empty plan rather
    // than failing the gate workflow.
    core.setOutput('plan', '[]');
    core.setOutput('is-authoritative', 'false');
    core.setOutput('affected-count', '0');
    core.setOutput('check-name', '');
    core.info('No pull request to judge.');
    return;
  }

  const config = await resolveConfig(octokit, repo);
  const ctx =
    parseContextInput(core.getInput('context')) ??
    (await resolveContext(octokit, repo, config, prNumber));

  const conclusionInput = optionalString('conclusion');
  const trigger: Trigger = conclusionInput ? 'ci-completed' : 'reconcile';
  const checks = new ChecksClient(octokit, repo, config.checkName);

  const ownCheck = ctx.sha ? await checks.read(ctx.sha) : null;
  const authorityCheck =
    ctx.authoritySha && ctx.authoritySha !== ctx.sha
      ? await checks.read(ctx.authoritySha)
      : ownCheck;

  // Re-derive whether this PR's CI was forced by an escape hatch. A forced
  // *failure* is real breakage in an intermediate state, which is the whole
  // reason `always-run-paths` exists.
  const forcedRun =
    trigger === 'ci-completed' && ctx.inStack && !ctx.isAuthority
      ? decide(ctx, await evaluateHatches(octokit, repo, prNumber, config)).forced
      : decide(ctx, NO_HATCH).forced;

  const { plan, isAuthoritative } = computeVerdict({
    ctx,
    trigger,
    ownConclusion: (conclusionInput ?? null) as RunConclusion | null,
    ownRunUrl: optionalString('run-url') ?? null,
    ownCheck,
    authorityCheck,
    forcedRun,
    config,
  });

  core.setOutput('plan', JSON.stringify(plan));
  core.setOutput('is-authoritative', String(isAuthoritative));
  core.setOutput('affected-count', String(plan.length));
  core.setOutput('check-name', config.checkName);

  const runId = optionalString('run-id');
  core.info(
    `Trigger: ${trigger}${runId ? ` (CI run ${runId})` : ''}. ` +
      `Plan (${plan.length} check${plan.length === 1 ? '' : 's'}):`,
  );
  for (const entry of plan) {
    core.info(
      `  #${entry.pr} ${entry.sha.slice(0, 7)} -> ${entry.status}` +
        `${entry.conclusion ? `/${entry.conclusion}` : ''} (${entry.reason})`,
    );
  }
  if (plan.length === 0) core.info('  (nothing to write)');
}

try {
  await main();
} catch (err) {
  fail(err);
}
