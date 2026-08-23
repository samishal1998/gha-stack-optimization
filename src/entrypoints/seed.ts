/**
 * `stack-optimization/seed` — guarantee the required check exists.
 *
 * A missing required check is the one state that hard-blocks a merge with no
 * way out, so this runs on every PR event that can change a head SHA and posts
 * the gate check immediately.
 */
import * as core from '@actions/core';
import { ChecksClient, withRetry } from '../checks.js';
import { fail } from '../github.js';
import { parseContextInput, resolve } from '../resolve.js';
import type { PlanEntry } from '../types.js';

async function main(): Promise<void> {
  const resolved = await resolve(parseContextInput(core.getInput('context')));
  if (!resolved) {
    throw new Error('Could not determine which pull request to seed. Pass the `pr-number` input.');
  }
  const { octokit, repo, config, ctx, prNumber } = resolved;
  if (ctx.sha === null) {
    core.info(`#${prNumber} has no head SHA to seed; nothing to do.`);
    core.setOutput('check-run-id', '');
    core.setOutput('state', 'skipped');
    return;
  }

  const client = new ChecksClient(octokit, repo, config.checkName);

  // Don't overwrite a verdict this SHA already earned or inherited. A seed only
  // fills the gap between "PR event" and "the gate has something to say".
  const existing = await client.read(ctx.sha);
  if (existing && existing.status === 'completed') {
    core.info(
      `#${prNumber} already has a ${existing.conclusion} gate check on ${ctx.sha.slice(0, 7)}; ` +
        'leaving it alone.',
    );
    core.setOutput('check-run-id', String(existing.id));
    core.setOutput('state', existing.status);
    return;
  }

  const waiting = ctx.inStack && !ctx.isAuthority && ctx.authorityPr !== null;
  const entry: PlanEntry = {
    pr: prNumber,
    sha: ctx.sha,
    status: waiting ? 'in_progress' : 'queued',
    conclusion: null,
    reason: 'seeded',
    title: waiting ? `Waiting on #${ctx.authorityPr}` : 'Waiting for CI',
    summary: waiting
      ? `Gated by #${ctx.authorityPr} (${ctx.authorityRole}). CI will not run on this PR; ` +
        'its verdict is mirrored from the authority once that run completes.'
      : 'Waiting for this PR’s CI to establish a verdict.',
    details_url: null,
    provenance: {
      v: 1,
      src: 'hold',
      auth: ctx.authorityPr,
      authSha: ctx.authoritySha,
      forced: false,
    },
  };

  const result = await withRetry(`seed #${prNumber}`, () => client.write(entry));
  core.setOutput('check-run-id', String(result.id));
  core.setOutput('state', entry.status);
  core.info(
    `Seeded "${config.checkName}" as ${entry.status} on #${prNumber} @ ${ctx.sha.slice(0, 7)}.`,
  );
}

try {
  await main();
} catch (err) {
  fail(err);
}
