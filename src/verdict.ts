/**
 * Pure verdict planning.
 *
 * Given a resolved topology, what just happened, and what the relevant gate
 * checks currently say, decide which check runs should be written where. No
 * network, no mutation — `propagate` executes what this returns.
 *
 * The invariant this module exists to protect: a non-authority's own CI
 * conclusion is never its verdict. A gated run concludes `success` trivially,
 * so treating it as a pass would silently defeat the entire gate.
 */
import type {
  AuthorityRole,
  GateCheckState,
  GateConclusion,
  PlanEntry,
  PlanReason,
  Provenance,
  ResolvedConfig,
  RunConclusion,
  SegmentMember,
  StackContext,
} from './types.js';

export type Trigger = 'ci-completed' | 'reconcile';

export interface VerdictInput {
  ctx: StackContext;
  trigger: Trigger;
  /** Conclusion of the CI run that just completed. Null on a reconcile. */
  ownConclusion: RunConclusion | null;
  /** html_url of that run, used as `details_url` across the segment. */
  ownRunUrl: string | null;
  /** Gate check currently on this PR's own head SHA, if any. */
  ownCheck: GateCheckState | null;
  /** Gate check currently on the authority's head SHA, if any. */
  authorityCheck: GateCheckState | null;
  /**
   * True when this PR ran real CI despite not being an authority, because an
   * escape hatch (`force-run-label` / `always-run-paths`) applied.
   */
  forcedRun: boolean;
  config: ResolvedConfig;
}

export interface VerdictPlan {
  plan: PlanEntry[];
  /** Whether the completing run established a verdict of its own. */
  isAuthoritative: boolean;
}

/**
 * `cancelled`, `skipped` and `stale` are not verdicts — nothing was proven, so
 * the gate holds rather than reporting.
 */
export function toGateConclusion(c: RunConclusion | null): GateConclusion | null {
  switch (c) {
    case 'success':
      return 'success';
    case 'neutral':
      return 'neutral';
    case 'failure':
    case 'timed_out':
    case 'action_required':
      return 'failure';
    default:
      return null;
  }
}

// `action_required` outranks a failure: it means a human has to act before this
// check means anything, so it must never be folded away by a worse-of.
const SEVERITY: Record<GateConclusion, number> = {
  success: 0,
  neutral: 1,
  failure: 2,
  action_required: 3,
};

/** Failure dominates. Used to fold a forced run's own result into its verdict. */
export function worstOf(a: GateConclusion, b: GateConclusion): GateConclusion {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** A gate check that reflects real CI on its own SHA, and has finished. */
function isEstablishedVerdict(check: GateCheckState | null): boolean {
  return (
    check !== null &&
    check.status === 'completed' &&
    check.provenance?.src === 'own-ci' &&
    toGateConclusion(check.conclusion) !== null
  );
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : 'unknown';
}

/**
 * A markdown link to the run that established a verdict, for the summary.
 *
 * `details_url` would be the natural place for this, but GitHub silently
 * discards that field on check runs created by the built-in `github-actions`
 * app and substitutes the check run's own page. Verified directly against the
 * API: an explicit `https://example.com/...` comes back rewritten. So the link
 * goes in the summary, which GitHub leaves alone.
 *
 * The URL comes from the `workflow_run` payload, not from anything a pull
 * request can influence.
 */
function runLink(label: string, url: string | null): string {
  return url ? ` [${label}](${url})` : '';
}

const ROLE_WORD: Record<AuthorityRole, string> = {
  head: 'stack head',
  checkpoint: 'checkpoint',
  'non-draft-head': 'highest non-draft PR',
};

/** How to describe the authority governing `ctx` in a check summary. */
function authorityRole(ctx: StackContext): string {
  return ctx.authorityRole ? ROLE_WORD[ctx.authorityRole] : 'authority';
}

function ownCiProvenance(forced: boolean, pr: number, sha: string | null): Provenance {
  return { v: 1, src: 'own-ci', auth: pr, authSha: sha, forced };
}

function mirrorProvenance(auth: number | null, authSha: string | null): Provenance {
  return { v: 1, src: 'mirror', auth, authSha, forced: false };
}

function holdProvenance(auth: number | null, authSha: string | null): Provenance {
  return { v: 1, src: 'hold', auth, authSha, forced: false };
}

interface EntryInit {
  pr: number;
  sha: string;
  conclusion: GateConclusion | null;
  reason: PlanReason;
  title: string;
  summary: string;
  detailsUrl: string | null;
  provenance: Provenance;
}

function entry(init: EntryInit): PlanEntry {
  return {
    pr: init.pr,
    sha: init.sha,
    status: init.conclusion === null ? 'in_progress' : 'completed',
    conclusion: init.conclusion,
    reason: init.reason,
    title: init.title,
    summary: init.summary,
    details_url: init.detailsUrl,
    provenance: init.provenance,
  };
}

const VERDICT_WORD: Record<GateConclusion, string> = {
  success: 'passed',
  neutral: 'was neutral',
  failure: 'failed',
  action_required: 'needs attention',
};

/**
 * Propagate an authority's verdict across its segment.
 *
 * The authority's own entry records `own-ci`; everyone below records `mirror`
 * plus the authority's SHA, which is what lets a later gate run tell an earned
 * green from an inherited one.
 */
function propagateAcrossSegment(
  ctx: StackContext,
  segment: readonly SegmentMember[],
  verdict: GateConclusion,
  detailsUrl: string | null,
  config: ResolvedConfig,
  selfReason: PlanReason,
  forced: boolean,
): PlanEntry[] {
  const authorityPr = ctx.pr;
  const authoritySha = ctx.sha;
  const role = authorityRole(ctx);
  const governed = segment.filter((m) => m.pr !== authorityPr).map((m) => `#${m.pr}`);
  const governs =
    governed.length > 0
      ? `Its result governs ${governed.join(', ')}.`
      : 'No other PR depends on it.';

  return segment.map((member) => {
    if (member.pr === authorityPr) {
      return entry({
        pr: member.pr,
        sha: member.sha,
        conclusion: verdict,
        reason: selfReason,
        title: `CI ${VERDICT_WORD[verdict]}`,
        summary:
          `This PR is the ${role} of its segment and ran the real CI suite. ${governs}` +
          runLink('View the run', detailsUrl),
        detailsUrl,
        provenance: ownCiProvenance(forced, authorityPr, authoritySha),
      });
    }

    // Hold parents rather than painting them red, if configured that way.
    if (verdict === 'failure' && !config.propagateFailures) {
      return entry({
        pr: member.pr,
        sha: member.sha,
        conclusion: null,
        reason: 'awaiting-authority',
        title: `Waiting on #${authorityPr}`,
        summary:
          `Gated by #${authorityPr} (${role}), which is currently failing. ` +
          '`propagate-failures` is off, so this PR is held rather than marked failed.',
        detailsUrl,
        provenance: holdProvenance(authorityPr, authoritySha),
      });
    }

    return entry({
      pr: member.pr,
      sha: member.sha,
      conclusion: verdict,
      reason: 'mirrors-authority',
      title: `Mirrors #${authorityPr} (${VERDICT_WORD[verdict]})`,
      summary:
        `Gated by #${authorityPr} (${role}). CI was not run on this PR: ` +
        `#${authorityPr}'s tree contains every change in this one, so its verdict applies here. ` +
        `Authority commit \`${shortSha(authoritySha)}\`.` +
        runLink(`View #${authorityPr}'s CI run`, detailsUrl),
      detailsUrl,
      provenance: mirrorProvenance(authorityPr, authoritySha),
    });
  });
}

/** Hold every member of a segment while its authority has nothing to say yet. */
function holdSegment(
  ctx: StackContext,
  segment: readonly SegmentMember[],
  selfSummary: string,
  selfReason: PlanReason,
): PlanEntry[] {
  const authorityPr = ctx.pr;
  return segment.map((member) =>
    member.pr === authorityPr
      ? entry({
          pr: member.pr,
          sha: member.sha,
          conclusion: null,
          reason: selfReason,
          title: 'Waiting for CI',
          summary: selfSummary,
          detailsUrl: null,
          provenance: holdProvenance(authorityPr, ctx.sha),
        })
      : entry({
          pr: member.pr,
          sha: member.sha,
          conclusion: null,
          reason: 'awaiting-authority',
          title: `Waiting on #${authorityPr}`,
          summary: `Gated by #${authorityPr}, which has not established a verdict yet.`,
          detailsUrl: null,
          provenance: holdProvenance(authorityPr, ctx.sha),
        }),
  );
}

const LEFT_STACK_SUMMARY =
  'This PR is no longer part of a stack, and the check it previously carried was ' +
  'inherited from a stack authority rather than earned by its own CI. That verdict ' +
  'no longer applies. Re-run the CI workflow on this PR (or push a commit) to ' +
  'establish a verdict of its own.';

/**
 * Compute the check runs that should be written.
 *
 * Two triggers:
 *   - `ci-completed`: a CI workflow run finished. If this PR is an authority (or
 *     ran under an escape hatch), that result is real.
 *   - `reconcile`: a PR event changed something structural (checkpoint label,
 *     draft state, stack membership, a merge). Nothing new was tested, so the
 *     verdict is re-derived from the checks already on record.
 */
export function computeVerdict(input: VerdictInput): VerdictPlan {
  const { ctx, trigger, ownConclusion, ownRunUrl, ownCheck, authorityCheck, forcedRun, config } =
    input;
  const own = toGateConclusion(ownConclusion);
  const sha = ctx.sha;

  // A PR with no resolvable head SHA has nothing to write to.
  if (sha === null) return { plan: [], isAuthoritative: false };

  // ---- Not in a stack: the PR owns its own verdict. ----------------------
  if (!ctx.inStack) {
    const inherited = ownCheck?.provenance?.src === 'mirror';

    if (inherited) {
      // Either the PR just left its stack (reconcile), or a run that started
      // while it was still gated has just completed. Neither is a verdict.
      return {
        plan: [
          entry({
            pr: ctx.pr,
            sha,
            conclusion: null,
            reason: 'left-stack-needs-own-ci',
            title: 'Needs its own CI run',
            summary: LEFT_STACK_SUMMARY,
            detailsUrl: null,
            provenance: holdProvenance(null, null),
          }),
        ],
        isAuthoritative: false,
      };
    }

    if (trigger === 'ci-completed' && own !== null) {
      return {
        plan: [
          entry({
            pr: ctx.pr,
            sha,
            conclusion: own,
            reason: 'not-in-stack-own-ci',
            title: `CI ${VERDICT_WORD[own]}`,
            summary: 'This PR is not part of a stack, so it reports its own CI result.',
            detailsUrl: ownRunUrl,
            provenance: ownCiProvenance(false, ctx.pr, sha),
          }),
        ],
        isAuthoritative: true,
      };
    }

    // Nothing new to say. Leave an established verdict alone; otherwise hold.
    if (isEstablishedVerdict(ownCheck)) return { plan: [], isAuthoritative: false };
    return {
      plan: [
        entry({
          pr: ctx.pr,
          sha,
          conclusion: null,
          reason: trigger === 'ci-completed' ? 'no-verdict-conclusion' : 'awaiting-authority',
          title: 'Waiting for CI',
          summary:
            trigger === 'ci-completed'
              ? `The CI run concluded \`${ownConclusion}\`, which is not a verdict. Waiting for a conclusive run.`
              : 'Waiting for this PR’s CI to establish a verdict.',
          detailsUrl: ownRunUrl,
          provenance: holdProvenance(null, null),
        }),
      ],
      isAuthoritative: false,
    };
  }

  // ---- Authority: our own CI result is real, and governs our segment. ----
  if (ctx.isAuthority) {
    if (trigger === 'ci-completed' && own !== null) {
      return {
        plan: propagateAcrossSegment(
          ctx,
          ctx.segment,
          own,
          ownRunUrl,
          config,
          'authority-own-ci',
          false,
        ),
        isAuthoritative: true,
      };
    }

    // Reconcile, or an inconclusive run. Re-publish a verdict this SHA actually
    // earned; otherwise hold. An authority whose check was inherited (a PR just
    // promoted to checkpoint) has never run its own CI and must not keep it.
    if (isEstablishedVerdict(ownCheck)) {
      const established = toGateConclusion(ownCheck!.conclusion)!;
      return {
        plan: propagateAcrossSegment(
          ctx,
          ctx.segment,
          established,
          ownCheck!.detailsUrl,
          config,
          'authority-republish',
          ownCheck!.provenance?.forced ?? false,
        ),
        isAuthoritative: false,
      };
    }

    const promoted = ownCheck?.provenance?.src === 'mirror';
    return {
      plan: holdSegment(
        ctx,
        ctx.segment,
        promoted
          ? `This PR now owns its own verdict (it is the ${authorityRole(ctx)} of its segment), ` +
              'but the check it carried was inherited from another PR. Re-run the CI workflow on this PR ' +
              'to establish a verdict for it and the PRs below it.'
          : 'This PR is the authority for its segment. Waiting for its CI to complete.',
        'authority-needs-own-ci',
      ),
      isAuthoritative: false,
    };
  }

  // ---- Non-authority: the verdict comes from the authority. --------------
  const authorityPr = ctx.authorityPr;
  const authorityEstablished = isEstablishedVerdict(authorityCheck);
  const mirrored = authorityEstablished ? toGateConclusion(authorityCheck!.conclusion)! : null;

  // An escape hatch made this PR run real CI. A failure there is real breakage
  // in an intermediate state, which is the whole point of the hatch, so it is
  // folded in rather than discarded. A pass still cannot stand on its own.
  // Only a *failure* is trustworthy here. A gated run that did no work still
  // concludes `success`, and `forcedRun` is recomputed from current labels and
  // paths — so a forced pass could be a skipped run wearing the hatch's badge.
  // A skipped run never fails, so a failure is always real work.
  const forcedOwn = trigger === 'ci-completed' && forcedRun && own === 'failure' ? own : null;

  if (mirrored !== null || forcedOwn !== null) {
    const verdict =
      mirrored !== null && forcedOwn !== null
        ? worstOf(mirrored, forcedOwn)
        : (mirrored ?? forcedOwn)!;
    // `forcedOwn` is only ever a failure, and it is this PR's own earned result.
    // It stands whether or not the authority happens to be failing too, and
    // regardless of propagate-failures, which governs inherited verdicts only.
    const decidedByOwn = forcedOwn !== null;

    if (verdict === 'failure' && !config.propagateFailures && !decidedByOwn) {
      return {
        plan: [
          entry({
            pr: ctx.pr,
            sha,
            conclusion: null,
            reason: 'awaiting-authority',
            title: `Waiting on #${authorityPr}`,
            summary:
              `Gated by #${authorityPr}, which is currently failing. ` +
              '`propagate-failures` is off, so this PR is held rather than marked failed.',
            detailsUrl: authorityCheck?.detailsUrl ?? null,
            provenance: holdProvenance(authorityPr, ctx.authoritySha),
          }),
        ],
        isAuthoritative: false,
      };
    }

    if (decidedByOwn) {
      return {
        plan: [
          entry({
            pr: ctx.pr,
            sha,
            conclusion: verdict,
            reason: 'forced-run-failure',
            title: `CI ${VERDICT_WORD[verdict]} on this PR`,
            summary:
              'This PR ran its own CI because an escape hatch applied ' +
              '(`force-run-label` or `always-run-paths`), and that run ' +
              `${VERDICT_WORD[verdict]}. Its own result stands even though ` +
              `#${authorityPr} governs the rest of the segment.`,
            detailsUrl: ownRunUrl,
            provenance: ownCiProvenance(true, ctx.pr, sha),
          }),
        ],
        isAuthoritative: true,
      };
    }

    return {
      plan: [
        entry({
          pr: ctx.pr,
          sha,
          conclusion: verdict,
          reason: 'mirrors-authority',
          title: `Mirrors #${authorityPr} (${VERDICT_WORD[verdict]})`,
          summary:
            `Gated by #${authorityPr} (${authorityRole(ctx)}). ` +
            `CI was not run on this PR: #${authorityPr}'s tree contains every change in this one, ` +
            `so its verdict applies here. Authority commit \`${shortSha(ctx.authoritySha)}\`.` +
            runLink(`View #${authorityPr}'s CI run`, authorityCheck?.detailsUrl ?? null),
          detailsUrl: authorityCheck?.detailsUrl ?? null,
          provenance: mirrorProvenance(authorityPr, ctx.authoritySha),
        }),
      ],
      isAuthoritative: false,
    };
  }

  // The authority has nothing established yet. Hold.
  return {
    plan: [
      entry({
        pr: ctx.pr,
        sha,
        conclusion: null,
        reason: 'awaiting-authority',
        title: `Waiting on #${authorityPr}`,
        summary:
          `Gated by #${authorityPr}, which has not established a verdict for ` +
          `commit \`${shortSha(ctx.authoritySha)}\` yet.`,
        detailsUrl: null,
        provenance: holdProvenance(authorityPr, ctx.authoritySha),
      }),
    ],
    isAuthoritative: false,
  };
}
