import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeAuthorities, computeContext, segmentOf } from '../src/topology.js';
import type { StackPR } from '../src/types.js';
import { makeStack, plainStack } from './fixtures/stacks.js';

function ctx(stack: StackPR[], pr: number, skipDraftHead = true) {
  return computeContext({
    stack,
    prNumber: pr,
    stackId: '42',
    targetBranch: 'main',
    options: { skipDraftHead },
  });
}

describe('computeContext — head-only stacks', () => {
  it('makes the head the authority and everyone below mirror it', () => {
    const stack = plainStack(5);
    const head = ctx(stack, 5);
    expect(head.isHead).toBe(true);
    expect(head.isAuthority).toBe(true);
    expect(head.authorityPr).toBe(5);
    expect(head.segment.map((m) => m.pr)).toEqual([5, 4, 3, 2, 1]);

    for (const pr of [1, 2, 3, 4]) {
      const c = ctx(stack, pr);
      expect(c.isAuthority).toBe(false);
      expect(c.authorityPr).toBe(5);
      expect(c.authoritySha).toBe('sha5');
    }
  });

  it('reports position 0-indexed from root, and size over active members', () => {
    const stack = plainStack(4);
    expect(ctx(stack, 1).position).toBe(0);
    expect(ctx(stack, 4).position).toBe(3);
    expect(ctx(stack, 1).isRoot).toBe(true);
    expect(ctx(stack, 1).size).toBe(4);
  });

  it('orders ancestors root-ward and descendants head-ward', () => {
    const stack = plainStack(5);
    const c = ctx(stack, 3);
    expect(c.ancestors.map((m) => m.pr)).toEqual([2, 1]);
    expect(c.descendants.map((m) => m.pr)).toEqual([4, 5]);
    expect(c.stack.map((m) => m.pr)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('computeContext — checkpoints', () => {
  // The PRD's worked example: six PRs, checkpoint on #3.
  const stack = makeStack([{}, {}, { checkpoint: true }, {}, {}, {}]);

  it('splits the stack into two segments at the checkpoint', () => {
    expect(ctx(stack, 6).segment.map((m) => m.pr)).toEqual([6, 5, 4]);
    expect(ctx(stack, 3).segment.map((m) => m.pr)).toEqual([3, 2, 1]);
  });

  it('routes #4 and #5 to the head and #1, #2 to the checkpoint', () => {
    expect(ctx(stack, 4).authorityPr).toBe(6);
    expect(ctx(stack, 5).authorityPr).toBe(6);
    expect(ctx(stack, 1).authorityPr).toBe(3);
    expect(ctx(stack, 2).authorityPr).toBe(3);
  });

  it('labels the governing authority by why it is one', () => {
    expect(ctx(stack, 6).authorityRole).toBe('head');
    expect(ctx(stack, 4).authorityRole).toBe('head');
    expect(ctx(stack, 3).authorityRole).toBe('checkpoint');
    expect(ctx(stack, 1).authorityRole).toBe('checkpoint');
  });

  it('makes both the head and the checkpoint authorities', () => {
    expect(ctx(stack, 6).isAuthority).toBe(true);
    expect(ctx(stack, 3).isAuthority).toBe(true);
    expect(ctx(stack, 3).isCheckpoint).toBe(true);
    expect(ctx(stack, 6).isCheckpoint).toBe(false);
  });

  it('treats a checkpoint on the root as its own single-PR segment', () => {
    const s = makeStack([{ checkpoint: true }, {}, {}]);
    expect(ctx(s, 1).segment.map((m) => m.pr)).toEqual([1]);
    expect(ctx(s, 2).authorityPr).toBe(3);
  });

  it('is a no-op when the checkpoint is on the head', () => {
    const s = makeStack([{}, {}, { checkpoint: true }]);
    expect(ctx(s, 3).segment.map((m) => m.pr)).toEqual([3, 2, 1]);
    expect(ctx(s, 1).authorityPr).toBe(3);
  });

  it('handles adjacent checkpoints', () => {
    const s = makeStack([{}, { checkpoint: true }, { checkpoint: true }, {}]);
    expect(ctx(s, 2).segment.map((m) => m.pr)).toEqual([2, 1]);
    expect(ctx(s, 3).segment.map((m) => m.pr)).toEqual([3]);
    expect(ctx(s, 4).segment.map((m) => m.pr)).toEqual([4]);
  });
});

describe('computeContext — merged and closed members', () => {
  it('promotes the next PR down when the head merges', () => {
    const stack = makeStack([{}, {}, { merged: true }]);
    const c = ctx(stack, 2);
    expect(c.isHead).toBe(true);
    expect(c.isAuthority).toBe(true);
    expect(c.size).toBe(2);
    expect(c.stack.map((m) => m.pr)).toEqual([1, 2]);
  });

  it('reindexes positions after a merged root', () => {
    const stack = makeStack([{ merged: true }, {}, {}]);
    expect(ctx(stack, 2).position).toBe(0);
    expect(ctx(stack, 2).isRoot).toBe(true);
  });

  it('drops closed members', () => {
    const stack = makeStack([{}, { closed: true }, {}]);
    expect(ctx(stack, 3).segment.map((m) => m.pr)).toEqual([3, 1]);
  });

  it('reports a closed PR itself as not in a stack', () => {
    const stack = makeStack([{}, {}, { closed: true }]);
    const c = ctx(stack, 3);
    expect(c.inStack).toBe(false);
    expect(c.sha).toBe('sha3');
  });
});

describe('computeContext — degenerate stacks', () => {
  it('treats a one-member stack as not in a stack (PRD 14.3)', () => {
    expect(ctx(plainStack(1), 1).inStack).toBe(false);
  });

  it('treats a stack whose members all merged but one as not in a stack', () => {
    const stack = makeStack([{ merged: true }, {}]);
    expect(ctx(stack, 2).inStack).toBe(false);
  });

  it('returns a standalone context for an unknown PR', () => {
    const c = ctx(plainStack(3), 99);
    expect(c.inStack).toBe(false);
    expect(c.sha).toBeNull();
    expect(c.size).toBe(0);
  });
});

describe('computeContext — draft head', () => {
  const stack = makeStack([{}, {}, {}, {}, { draft: true }, { draft: true }]);

  it('shields the mergeable part of the stack from a WIP head', () => {
    // #6 (draft head) and #4 (highest non-draft) are both authorities.
    expect(ctx(stack, 6).isAuthority).toBe(true);
    expect(ctx(stack, 4).isAuthority).toBe(true);
    expect(ctx(stack, 5).isAuthority).toBe(false);

    // The draft region is its own segment; #1-#4 answer to #4, not the draft head.
    expect(ctx(stack, 6).segment.map((m) => m.pr)).toEqual([6, 5]);
    expect(ctx(stack, 4).segment.map((m) => m.pr)).toEqual([4, 3, 2, 1]);
    expect(ctx(stack, 1).authorityPr).toBe(4);
  });

  it('labels the draft-head fallback authority as neither head nor checkpoint', () => {
    expect(ctx(stack, 1).authorityRole).toBe('non-draft-head');
    expect(ctx(stack, 4).authorityRole).toBe('non-draft-head');
    expect(ctx(stack, 6).authorityRole).toBe('head');
    expect(ctx(stack, 5).authorityRole).toBe('head');
  });

  it('keeps the draft head as the sole authority when skip-draft-head is off', () => {
    expect(ctx(stack, 4, false).isAuthority).toBe(false);
    expect(ctx(stack, 1, false).authorityPr).toBe(6);
    expect(ctx(stack, 6, false).segment.map((m) => m.pr)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('does nothing when the head is not a draft', () => {
    const s = makeStack([{}, { draft: true }, {}]);
    expect(ctx(s, 3).segment.map((m) => m.pr)).toEqual([3, 2, 1]);
    expect(ctx(s, 2).isAuthority).toBe(false);
  });

  it('leaves an all-draft stack governed by its head alone', () => {
    const s = makeStack([{ draft: true }, { draft: true }]);
    expect(ctx(s, 2).segment.map((m) => m.pr)).toEqual([2, 1]);
    expect(ctx(s, 1).authorityPr).toBe(2);
  });

  it('still honours checkpoints below a draft head', () => {
    const s = makeStack([{}, { checkpoint: true }, {}, { draft: true }]);
    expect(ctx(s, 4).segment.map((m) => m.pr)).toEqual([4]);
    expect(ctx(s, 3).isAuthority).toBe(true);
    expect(ctx(s, 3).segment.map((m) => m.pr)).toEqual([3]);
    expect(ctx(s, 1).authorityPr).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Properties. These are the invariants the whole design rests on: if any PR
// ended up with two authorities, or none, the gate would either double-report
// or block a merge forever.
// ---------------------------------------------------------------------------

const arbStack = fc
  .array(
    fc.record({
      draft: fc.boolean(),
      checkpoint: fc.boolean(),
      merged: fc.boolean(),
      closed: fc.boolean(),
    }),
    { minLength: 2, maxLength: 10 },
  )
  .map((specs) => makeStack(specs));

describe('properties', () => {
  it('gives every active PR exactly one authority', () => {
    fc.assert(
      fc.property(arbStack, fc.boolean(), (stack, skipDraftHead) => {
        const active = stack.filter((pr) => pr.state === 'open' && !pr.merged);
        if (active.length <= 1) return;
        for (const pr of active) {
          const c = ctx(stack, pr.number, skipDraftHead);
          expect(c.inStack).toBe(true);
          expect(c.authorityPr).not.toBeNull();
          expect(active.some((a) => a.number === c.authorityPr)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('places every active PR in exactly one segment', () => {
    fc.assert(
      fc.property(arbStack, fc.boolean(), (stack, skipDraftHead) => {
        const active = stack.filter((pr) => pr.state === 'open' && !pr.merged);
        if (active.length <= 1) return;
        const authorities = computeAuthorities(active, { skipDraftHead });

        const seen = new Map<number, number>();
        for (let i = 0; i < active.length; i++) {
          if (!authorities.has(active[i]!.number)) continue;
          for (const member of segmentOf(active, i, authorities)) {
            seen.set(member.pr, (seen.get(member.pr) ?? 0) + 1);
          }
        }
        for (const pr of active) {
          expect(seen.get(pr.number)).toBe(1);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('keeps a segment contiguous, with its authority on top', () => {
    fc.assert(
      fc.property(arbStack, fc.boolean(), (stack, skipDraftHead) => {
        const active = stack.filter((pr) => pr.state === 'open' && !pr.merged);
        if (active.length <= 1) return;
        const index = new Map(active.map((pr, i) => [pr.number, i]));

        for (const pr of active) {
          const c = ctx(stack, pr.number, skipDraftHead);
          const positions = c.segment.map((m) => index.get(m.pr)!);
          // Authority first, then strictly descending by one.
          expect(positions[0]).toBe(index.get(c.authorityPr!)!);
          for (let i = 1; i < positions.length; i++) {
            expect(positions[i]).toBe(positions[i - 1]! - 1);
          }
          // The authority is at or above every member, and the PR is a member.
          expect(positions.every((p) => p <= positions[0]!)).toBe(true);
          expect(c.segment.some((m) => m.pr === pr.number)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('always makes the head an authority, so nothing is ungoverned', () => {
    fc.assert(
      fc.property(arbStack, fc.boolean(), (stack, skipDraftHead) => {
        const active = stack.filter((pr) => pr.state === 'open' && !pr.merged);
        if (active.length <= 1) return;
        const head = active[active.length - 1]!;
        expect(ctx(stack, head.number, skipDraftHead).isAuthority).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('makes a PR its own authority exactly when it is an authority', () => {
    fc.assert(
      fc.property(arbStack, fc.boolean(), (stack, skipDraftHead) => {
        const active = stack.filter((pr) => pr.state === 'open' && !pr.merged);
        if (active.length <= 1) return;
        for (const pr of active) {
          const c = ctx(stack, pr.number, skipDraftHead);
          expect(c.isAuthority).toBe(c.authorityPr === pr.number);
        }
      }),
      { numRuns: 200 },
    );
  });
});
