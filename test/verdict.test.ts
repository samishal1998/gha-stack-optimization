import { describe, expect, it } from 'vitest';
import { computeVerdict, toGateConclusion, worstOf } from '../src/verdict.js';
import { computeContext } from '../src/topology.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import type {
  GateCheckState,
  Provenance,
  ResolvedConfig,
  RunConclusion,
  StackContext,
  StackPR,
  VerdictSource,
} from '../src/types.js';
import type { Trigger, VerdictInput } from '../src/verdict.js';
import { makeStack, plainStack } from './fixtures/stacks.js';

function contextFor(stack: StackPR[], pr: number, skipDraftHead = true): StackContext {
  return computeContext({
    stack,
    prNumber: pr,
    stackId: '7',
    targetBranch: 'main',
    options: { skipDraftHead },
  });
}

function check(
  src: VerdictSource,
  conclusion: RunConclusion | null,
  extra: Partial<GateCheckState> & { forced?: boolean } = {},
): GateCheckState {
  const provenance: Provenance = {
    v: 1,
    src,
    auth: null,
    authSha: null,
    forced: extra.forced ?? false,
  };
  return {
    id: 1,
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
    detailsUrl: 'https://example.test/run/1',
    provenance,
    ...('status' in extra ? { status: extra.status! } : {}),
  };
}

function plan(over: Partial<VerdictInput> & { ctx: StackContext }) {
  const config: ResolvedConfig = over.config ?? DEFAULT_CONFIG;
  return computeVerdict({
    trigger: 'ci-completed' as Trigger,
    ownConclusion: null,
    ownRunUrl: 'https://example.test/run/99',
    ownCheck: null,
    authorityCheck: null,
    forcedRun: false,
    ...over,
    config,
  });
}

describe('toGateConclusion', () => {
  it('maps real outcomes and refuses non-verdicts', () => {
    expect(toGateConclusion('success')).toBe('success');
    expect(toGateConclusion('failure')).toBe('failure');
    expect(toGateConclusion('timed_out')).toBe('failure');
    expect(toGateConclusion('action_required')).toBe('failure');
    expect(toGateConclusion('neutral')).toBe('neutral');
    expect(toGateConclusion('cancelled')).toBeNull();
    expect(toGateConclusion('skipped')).toBeNull();
    expect(toGateConclusion('stale')).toBeNull();
    expect(toGateConclusion(null)).toBeNull();
  });
});

describe('worstOf', () => {
  it('lets failure dominate', () => {
    expect(worstOf('success', 'failure')).toBe('failure');
    expect(worstOf('failure', 'success')).toBe('failure');
    expect(worstOf('neutral', 'success')).toBe('neutral');
    expect(worstOf('success', 'success')).toBe('success');
  });
});

describe('authority CI completes', () => {
  const stack = plainStack(4);

  it('propagates a pass down the whole segment', () => {
    const { plan: entries, isAuthoritative } = plan({
      ctx: contextFor(stack, 4),
      trigger: 'ci-completed',
      ownConclusion: 'success',
    });
    expect(isAuthoritative).toBe(true);
    expect(entries.map((e) => e.pr)).toEqual([4, 3, 2, 1]);
    expect(entries.every((e) => e.conclusion === 'success')).toBe(true);
    expect(entries.every((e) => e.status === 'completed')).toBe(true);
  });

  it('records provenance so an inherited green is distinguishable', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 4),
      trigger: 'ci-completed',
      ownConclusion: 'success',
    });
    expect(entries[0]!.provenance.src).toBe('own-ci');
    for (const e of entries.slice(1)) {
      expect(e.provenance.src).toBe('mirror');
      expect(e.provenance.auth).toBe(4);
      expect(e.provenance.authSha).toBe('sha4');
    }
  });

  it('points mirrored checks at the authority run', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 4),
      trigger: 'ci-completed',
      ownConclusion: 'failure',
      ownRunUrl: 'https://example.test/run/head',
    });
    expect(entries.every((e) => e.details_url === 'https://example.test/run/head')).toBe(true);
    expect(entries[1]!.summary).toContain('#4');
  });

  it('puts the authority run link in the summary, not just details_url', () => {
    // GitHub discards details_url on check runs created by the github-actions
    // app, so the summary is the only channel that survives.
    const { plan: entries } = plan({
      ctx: contextFor(stack, 4),
      trigger: 'ci-completed',
      ownConclusion: 'failure',
      ownRunUrl: 'https://example.test/run/head',
    });
    expect(entries[0]!.summary).toContain('[View the run](https://example.test/run/head)');
    for (const e of entries.slice(1)) {
      expect(e.summary).toContain("[View #4's CI run](https://example.test/run/head)");
    }
  });

  it('omits the link when there is no run url', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 4),
      trigger: 'ci-completed',
      ownConclusion: 'success',
      ownRunUrl: undefined,
    });
    expect(entries.every((e) => !e.summary.includes(']('))).toBe(true);
  });

  it('propagates a failure down the segment by default', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 4),
      trigger: 'ci-completed',
      ownConclusion: 'failure',
    });
    expect(entries.every((e) => e.conclusion === 'failure')).toBe(true);
  });

  it('holds parents instead of reddening them when propagate-failures is off', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 4),
      trigger: 'ci-completed',
      ownConclusion: 'failure',
      config: { ...DEFAULT_CONFIG, propagateFailures: false },
    });
    expect(entries[0]!.conclusion).toBe('failure'); // the authority earned it
    for (const e of entries.slice(1)) {
      expect(e.status).toBe('in_progress');
      expect(e.conclusion).toBeNull();
    }
  });

  it('stops at the checkpoint below', () => {
    const s = makeStack([{}, {}, { checkpoint: true }, {}, {}, {}]);
    const { plan: entries } = plan({
      ctx: contextFor(s, 6),
      trigger: 'ci-completed',
      ownConclusion: 'failure',
    });
    // The PRD's partial-merge requirement: #1-#3 must not inherit the head's red.
    expect(entries.map((e) => e.pr)).toEqual([6, 5, 4]);
  });

  it('does not treat a cancelled run as a verdict', () => {
    const { plan: entries, isAuthoritative } = plan({
      ctx: contextFor(stack, 4),
      trigger: 'ci-completed',
      ownConclusion: 'cancelled',
    });
    expect(isAuthoritative).toBe(false);
    expect(entries.every((e) => e.status === 'in_progress')).toBe(true);
  });

  it('does not treat a skipped run as a verdict', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 4),
      trigger: 'ci-completed',
      ownConclusion: 'skipped',
    });
    expect(entries.every((e) => e.conclusion === null)).toBe(true);
  });
});

describe('non-authority', () => {
  const stack = plainStack(4);

  it('mirrors an established authority verdict', () => {
    const { plan: entries, isAuthoritative } = plan({
      ctx: contextFor(stack, 2),
      trigger: 'ci-completed',
      ownConclusion: 'success',
      authorityCheck: check('own-ci', 'failure'),
    });
    expect(isAuthoritative).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.pr).toBe(2);
    // The invariant: its own trivially-successful gated run is ignored.
    expect(entries[0]!.conclusion).toBe('failure');
    expect(entries[0]!.provenance.src).toBe('mirror');
  });

  it('never uses its own skipped run as a pass', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 2),
      trigger: 'ci-completed',
      ownConclusion: 'success',
      authorityCheck: null,
    });
    expect(entries[0]!.status).toBe('in_progress');
    expect(entries[0]!.conclusion).toBeNull();
    expect(entries[0]!.reason).toBe('awaiting-authority');
  });

  it('holds while the authority is still running', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 2),
      trigger: 'reconcile',
      authorityCheck: check('hold', null),
    });
    expect(entries[0]!.status).toBe('in_progress');
    expect(entries[0]!.summary).toContain('#4');
  });

  it('refuses to mirror a check the authority itself only inherited', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 2),
      trigger: 'reconcile',
      authorityCheck: check('mirror', 'success'),
    });
    expect(entries[0]!.conclusion).toBeNull();
  });

  it('refuses to mirror a check of unknown provenance', () => {
    const unknown: GateCheckState = {
      id: 9,
      status: 'completed',
      conclusion: 'success',
      detailsUrl: null,
      provenance: null,
    };
    const { plan: entries } = plan({
      ctx: contextFor(stack, 2),
      trigger: 'reconcile',
      authorityCheck: unknown,
    });
    expect(entries[0]!.conclusion).toBeNull();
  });

  it('holds rather than reddening when propagate-failures is off', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 2),
      trigger: 'reconcile',
      authorityCheck: check('own-ci', 'failure'),
      config: { ...DEFAULT_CONFIG, propagateFailures: false },
    });
    expect(entries[0]!.status).toBe('in_progress');
  });
});

describe('forced runs (escape hatches)', () => {
  const stack = plainStack(4);

  it('keeps its own failure even when the authority is green', () => {
    const { plan: entries, isAuthoritative } = plan({
      ctx: contextFor(stack, 2),
      trigger: 'ci-completed',
      ownConclusion: 'failure',
      forcedRun: true,
      authorityCheck: check('own-ci', 'success'),
    });
    expect(isAuthoritative).toBe(true);
    expect(entries[0]!.conclusion).toBe('failure');
    expect(entries[0]!.reason).toBe('forced-run-failure');
    expect(entries[0]!.provenance.src).toBe('own-ci');
    expect(entries[0]!.provenance.forced).toBe(true);
  });

  it('reports its own failure even when propagate-failures is off', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 2),
      trigger: 'ci-completed',
      ownConclusion: 'failure',
      forcedRun: true,
      authorityCheck: check('own-ci', 'success'),
      config: { ...DEFAULT_CONFIG, propagateFailures: false },
    });
    expect(entries[0]!.conclusion).toBe('failure');
  });

  it('reports its own failure even when the authority is failing too', () => {
    // Previously suppressed: the two conclusions matched, so this fell into the
    // propagate-failures hold and the PR's own earned failure vanished.
    const { plan: entries } = plan({
      ctx: contextFor(stack, 2),
      trigger: 'ci-completed',
      ownConclusion: 'failure',
      forcedRun: true,
      authorityCheck: check('own-ci', 'failure'),
      config: { ...DEFAULT_CONFIG, propagateFailures: false },
    });
    expect(entries[0]!.status).toBe('completed');
    expect(entries[0]!.conclusion).toBe('failure');
    expect(entries[0]!.reason).toBe('forced-run-failure');
    expect(entries[0]!.provenance.src).toBe('own-ci');
  });

  it('records own-ci provenance when its own forced failure decides the verdict', () => {
    for (const authorityCheck of [null, check('own-ci', 'success'), check('own-ci', 'failure')]) {
      const { plan: entries } = plan({
        ctx: contextFor(stack, 2),
        trigger: 'ci-completed',
        ownConclusion: 'failure',
        forcedRun: true,
        authorityCheck,
      });
      expect(entries[0]!.conclusion).toBe('failure');
      expect(entries[0]!.provenance.src).toBe('own-ci');
      expect(entries[0]!.provenance.forced).toBe(true);
    }
  });

  it('still defers to the authority when its own forced run passed', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 2),
      trigger: 'ci-completed',
      ownConclusion: 'success',
      forcedRun: true,
      authorityCheck: check('own-ci', 'failure'),
    });
    expect(entries[0]!.conclusion).toBe('failure');
    expect(entries[0]!.reason).toBe('mirrors-authority');
  });

  it('does not let a forced pass stand on its own', () => {
    // A gated run that did no work also concludes `success`, and `forcedRun` is
    // recomputed from current labels — so a pass here proves nothing.
    const { plan: entries, isAuthoritative } = plan({
      ctx: contextFor(stack, 2),
      trigger: 'ci-completed',
      ownConclusion: 'success',
      forcedRun: true,
      authorityCheck: null,
    });
    expect(isAuthoritative).toBe(false);
    expect(entries[0]!.status).toBe('in_progress');
    expect(entries[0]!.conclusion).toBeNull();
  });

  it('never writes own-ci provenance off a forced pass', () => {
    // The false pass this guard exists to prevent: label added, a stale gated
    // run completes, and its trivial `success` becomes a permanent green that
    // survives reconciles and promotion to checkpoint.
    for (const authorityCheck of [null, check('own-ci', 'success'), check('mirror', 'success')]) {
      const { plan: entries } = plan({
        ctx: contextFor(stack, 2),
        trigger: 'ci-completed',
        ownConclusion: 'success',
        forcedRun: true,
        authorityCheck,
      });
      for (const e of entries) {
        expect(e.provenance.src).not.toBe('own-ci');
      }
    }
  });
});

describe('checkpoint promoted mid-flight', () => {
  it('invalidates the inherited check and asks for a real run', () => {
    const s = makeStack([{}, {}, { checkpoint: true }, {}]);
    const { plan: entries } = plan({
      ctx: contextFor(s, 3),
      trigger: 'reconcile',
      ownCheck: check('mirror', 'success'),
    });
    expect(entries.map((e) => e.pr)).toEqual([3, 2, 1]);
    expect(entries[0]!.reason).toBe('authority-needs-own-ci');
    expect(entries[0]!.conclusion).toBeNull();
    expect(entries[0]!.summary).toContain('inherited');
    // Everyone below is held too — they can no longer rely on the old head.
    expect(entries.slice(1).every((e) => e.status === 'in_progress')).toBe(true);
  });

  it('re-publishes a verdict the authority actually earned', () => {
    const s = makeStack([{}, {}, { checkpoint: true }, {}]);
    const { plan: entries, isAuthoritative } = plan({
      ctx: contextFor(s, 3),
      trigger: 'reconcile',
      ownCheck: check('own-ci', 'success'),
    });
    expect(isAuthoritative).toBe(false);
    expect(entries.map((e) => e.pr)).toEqual([3, 2, 1]);
    expect(entries.every((e) => e.conclusion === 'success')).toBe(true);
    expect(entries[0]!.reason).toBe('authority-republish');
    expect(entries[0]!.details_url).toBe('https://example.test/run/1');
  });
});

describe('not in a stack', () => {
  const solo = plainStack(1);

  it('reports its own CI result', () => {
    const { plan: entries, isAuthoritative } = plan({
      ctx: contextFor(solo, 1),
      trigger: 'ci-completed',
      ownConclusion: 'failure',
    });
    expect(isAuthoritative).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.conclusion).toBe('failure');
    expect(entries[0]!.reason).toBe('not-in-stack-own-ci');
    expect(entries[0]!.provenance.src).toBe('own-ci');
  });

  it('holds a PR that left its stack carrying an inherited green (PRD 14.1)', () => {
    const { plan: entries } = plan({
      ctx: contextFor(solo, 1),
      trigger: 'reconcile',
      ownCheck: check('mirror', 'success'),
    });
    expect(entries[0]!.status).toBe('in_progress');
    expect(entries[0]!.reason).toBe('left-stack-needs-own-ci');
    expect(entries[0]!.summary).toContain('no longer applies');
  });

  it('holds even if a run completes on the same SHA it was mirroring', () => {
    // That run started while the PR was still gated, so it proved nothing.
    const { plan: entries } = plan({
      ctx: contextFor(solo, 1),
      trigger: 'ci-completed',
      ownConclusion: 'success',
      ownCheck: check('mirror', 'success'),
    });
    expect(entries[0]!.conclusion).toBeNull();
    expect(entries[0]!.reason).toBe('left-stack-needs-own-ci');
  });

  it('leaves an established verdict alone on a reconcile', () => {
    const { plan: entries } = plan({
      ctx: contextFor(solo, 1),
      trigger: 'reconcile',
      ownCheck: check('own-ci', 'success'),
    });
    expect(entries).toEqual([]);
  });

  it('writes nothing when the PR has no resolvable head SHA', () => {
    const { plan: entries } = plan({ ctx: contextFor(plainStack(3), 99) });
    expect(entries).toEqual([]);
  });
});

describe('draft head', () => {
  const stack = makeStack([{}, {}, {}, { draft: true }]);

  it('keeps a red draft head off the mergeable part of the stack', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 4),
      trigger: 'ci-completed',
      ownConclusion: 'failure',
    });
    expect(entries.map((e) => e.pr)).toEqual([4]);
  });

  it('lets the highest non-draft PR govern the rest', () => {
    const { plan: entries } = plan({
      ctx: contextFor(stack, 3),
      trigger: 'ci-completed',
      ownConclusion: 'success',
    });
    expect(entries.map((e) => e.pr)).toEqual([3, 2, 1]);
    // #3 is neither the head nor a checkpoint — it is the draft-head fallback,
    // and the summary should say so rather than inventing a label.
    expect(entries[0]!.summary).toContain('highest non-draft PR');
    expect(entries[0]!.summary).not.toContain('checkpoint');
  });
});

describe('plan shape', () => {
  it('never writes a completed check without a conclusion', () => {
    const cases: Array<Partial<VerdictInput>> = [
      { trigger: 'ci-completed', ownConclusion: 'success' },
      { trigger: 'ci-completed', ownConclusion: 'cancelled' },
      { trigger: 'reconcile' },
      { trigger: 'reconcile', ownCheck: check('mirror', 'success') },
    ];
    const stack = makeStack([{}, {}, { checkpoint: true }, {}]);
    for (const over of cases) {
      for (const pr of [1, 2, 3, 4]) {
        for (const e of plan({ ctx: contextFor(stack, pr), ...over }).plan) {
          if (e.status === 'completed') expect(e.conclusion).not.toBeNull();
          else expect(e.conclusion).toBeNull();
          expect(e.sha).toBeTruthy();
          expect(e.summary.length).toBeGreaterThan(0);
          expect(e.title.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
