/** `stack-optimization/should-run` — the first step in the CI workflow. */
import * as core from '@actions/core';
import { fail, getRepo, makeOctokit, prNumberFromEvent } from '../github.js';
import { resolveConfig } from '../config.js';
import { parseContextInput, resolveContext } from '../resolve.js';
import { NO_HATCH, decide, evaluateHatches } from '../should-run.js';

async function main(): Promise<void> {
  const prNumber = prNumberFromEvent();
  if (prNumber === null) {
    // Not a pull request event at all: nothing is gated, so run.
    core.info('Not a pull request event — CI should run.');
    core.setOutput('should-run', 'true');
    core.setOutput('reason', 'not-in-stack');
    core.setOutput('authority-pr', '');
    core.setOutput('forced', 'false');
    return;
  }

  const octokit = makeOctokit();
  const repo = getRepo();
  const config = await resolveConfig(octokit, repo);

  const ctx =
    parseContextInput(core.getInput('context')) ??
    (await resolveContext(octokit, repo, config, prNumber));

  // Escape hatches only matter for PRs that would otherwise skip, so the
  // changed-files request is not paid for on every run.
  const preliminary = decide(ctx, NO_HATCH);
  const hatch = preliminary.shouldRun
    ? NO_HATCH
    : await evaluateHatches(octokit, repo, prNumber, config);
  const decision = decide(ctx, hatch);

  core.setOutput('should-run', String(decision.shouldRun));
  core.setOutput('reason', decision.reason);
  core.setOutput('authority-pr', ctx.authorityPr === null ? '' : String(ctx.authorityPr));
  core.setOutput('forced', String(decision.forced));

  if (decision.shouldRun) {
    core.info(`CI should run on #${prNumber} (${decision.reason}).`);
  } else {
    core.info(
      `Skipping CI on #${prNumber}: it mirrors #${ctx.authorityPr}, whose tree contains ` +
        'every change in this PR. The stack-optimization check will be posted out of band.',
    );
  }
}

try {
  await main();
} catch (err) {
  fail(err);
}
