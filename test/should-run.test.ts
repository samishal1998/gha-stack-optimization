import { describe, expect, it } from 'vitest';
import { NO_HATCH, decide, matchesAny } from '../src/should-run.js';
import { computeContext } from '../src/topology.js';
import type { StackContext, StackPR } from '../src/types.js';
import { makeStack, plainStack } from './fixtures/stacks.js';

function contextFor(stack: StackPR[], pr: number, skipDraftHead = true): StackContext {
  return computeContext({
    stack,
    prNumber: pr,
    stackId: '3',
    targetBranch: 'main',
    options: { skipDraftHead },
  });
}

describe('decide', () => {
  const stack = makeStack([{}, {}, { checkpoint: true }, {}, {}, {}]);

  it('runs CI on a PR that is not in a stack', () => {
    const d = decide(contextFor(plainStack(1), 1), NO_HATCH);
    expect(d).toEqual({ shouldRun: true, reason: 'not-in-stack', forced: false });
  });

  it('runs CI on the head', () => {
    expect(decide(contextFor(stack, 6), NO_HATCH)).toEqual({
      shouldRun: true,
      reason: 'is-head',
      forced: false,
    });
  });

  it('runs CI on a checkpoint', () => {
    expect(decide(contextFor(stack, 3), NO_HATCH)).toEqual({
      shouldRun: true,
      reason: 'is-checkpoint',
      forced: false,
    });
  });

  it('skips every non-authority', () => {
    for (const pr of [1, 2, 4, 5]) {
      expect(decide(contextFor(stack, pr), NO_HATCH)).toEqual({
        shouldRun: false,
        reason: 'mirrors-authority',
        forced: false,
      });
    }
  });

  it('reports the draft-head fallback authority distinctly', () => {
    const s = makeStack([{}, {}, { draft: true }]);
    expect(decide(contextFor(s, 2), NO_HATCH)).toEqual({
      shouldRun: true,
      reason: 'is-authority',
      forced: false,
    });
  });

  it('marks a label-forced run as forced', () => {
    const d = decide(contextFor(stack, 4), { forcedByLabel: true, forcedByPath: false });
    expect(d).toEqual({ shouldRun: true, reason: 'forced-by-label', forced: true });
  });

  it('marks a path-forced run as forced', () => {
    const d = decide(contextFor(stack, 4), { forcedByLabel: false, forcedByPath: true });
    expect(d).toEqual({ shouldRun: true, reason: 'forced-by-path', forced: true });
  });

  it('does not mark an authority as forced, even with a hatch label', () => {
    // The gate keys "is this PR's own failure real?" off `forced`, so an
    // authority must never be reported as forced.
    const d = decide(contextFor(stack, 6), { forcedByLabel: true, forcedByPath: true });
    expect(d.forced).toBe(false);
    expect(d.reason).toBe('is-head');
  });
});

describe('matchesAny', () => {
  it('matches the PRD config example', () => {
    const globs = ['migrations/**', '**/*.sql'];
    expect(matchesAny('migrations/0001_init.py', globs)).toBe(true);
    expect(matchesAny('migrations/nested/deep/x.py', globs)).toBe(true);
    expect(matchesAny('db/schema.sql', globs)).toBe(true);
    expect(matchesAny('schema.sql', globs)).toBe(true);
    expect(matchesAny('src/index.ts', globs)).toBe(false);
    expect(matchesAny('docs/migrations.md', globs)).toBe(false);
  });

  it('matches dotfiles, which CI paths often are', () => {
    expect(matchesAny('.github/workflows/ci.yml', ['.github/**'])).toBe(true);
    expect(matchesAny('.github/workflows/ci.yml', ['**/*.yml'])).toBe(true);
  });

  it('is false for an empty glob list', () => {
    expect(matchesAny('anything.ts', [])).toBe(false);
  });
});
