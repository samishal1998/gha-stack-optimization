import type { StackPR } from '../../src/types.js';

export interface PRSpec {
  number?: number;
  draft?: boolean;
  checkpoint?: boolean;
  merged?: boolean;
  closed?: boolean;
}

/**
 * Build a stack root -> head. PR numbers default to 1..n so index i is PR i+1,
 * and the SHA is derived from the number to keep assertions readable.
 */
export function makeStack(specs: readonly PRSpec[]): StackPR[] {
  return specs.map((spec, i) => {
    const number = spec.number ?? i + 1;
    return {
      number,
      sha: `sha${number}`,
      headRef: `branch-${number}`,
      draft: spec.draft ?? false,
      state: spec.closed ? ('closed' as const) : ('open' as const),
      merged: spec.merged ?? false,
      isCheckpoint: spec.checkpoint ?? false,
    };
  });
}

/** A plain stack of `n` open, non-draft, non-checkpoint PRs. */
export function plainStack(n: number): StackPR[] {
  return makeStack(Array.from({ length: n }, () => ({})));
}
