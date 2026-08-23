/** `stack-optimization/context` — resolve stack topology for a PR. Pure read. */
import * as core from '@actions/core';
import { fail, workflowRunPayload } from '../github.js';
import { resolve, setContextOutputs, setEmptyContextOutputs } from '../resolve.js';

async function main(): Promise<void> {
  const resolved = await resolve();
  if (!resolved) {
    // A completed workflow run with no pull request behind it is ordinary — every
    // push to a branch without a PR produces one. Failing here would paint the
    // gate red on every push to the default branch, which is both wrong and the
    // fastest way to teach people to ignore it.
    if (workflowRunPayload()) {
      core.info('No pull request is associated with this run; nothing to gate.');
      setEmptyContextOutputs();
      return;
    }
    throw new Error(
      'Could not determine which pull request to resolve. Pass the `pr-number` input.',
    );
  }
  const { ctx } = resolved;
  setContextOutputs(ctx);
  core.info(
    ctx.inStack
      ? `#${ctx.pr} is ${ctx.position! + 1}/${ctx.size} in stack ${ctx.stackId}; ` +
          `authority is #${ctx.authorityPr} (${ctx.authorityRole}); ` +
          `segment ${ctx.segment.map((m) => `#${m.pr}`).join(' -> ')}`
      : `#${ctx.pr} is not part of a stack.`,
  );
}

try {
  await main();
} catch (err) {
  fail(err);
}
