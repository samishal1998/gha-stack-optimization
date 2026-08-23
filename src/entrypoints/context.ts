/** `stack-optimization/context` — resolve stack topology for a PR. Pure read. */
import * as core from '@actions/core';
import { fail } from '../github.js';
import { resolve, setContextOutputs } from '../resolve.js';

async function main(): Promise<void> {
  const resolved = await resolve();
  if (!resolved) {
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
