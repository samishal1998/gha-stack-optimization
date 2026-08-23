# stack-optimization

**Composable GitHub Actions for stack-aware CI gating.**

In a stacked pull request, every PR in the chain runs the full CI suite. For a
five-PR stack that means five full runs, even though only the head meaningfully
validates anything — the head contains every change below it. Everything
underneath is spending runner minutes to re-prove a subset of what the head has
already proved.

`stack-optimization` runs CI **once per stack segment** instead of once per PR, and posts
a single stable required check on every PR so that nothing is ever blocked by a
check that never reported.

It is built on GitHub's [native stacked pull requests][native] (public preview),
so the stack's shape is read from the API. There are no label conventions to
follow, no body markers to maintain, and no `base_ref` chains to walk.

> **New here?** This page covers the model, the two warnings you should read
> before adopting it, and a working setup in three steps. For what each action
> does individually, how to compose them yourself, and troubleshooting, see the
> **[full guide](GUIDE.md)**.

[native]: https://docs.github.com/en/pull-requests/get-started/about-stacked-prs

---

## How it works

**An authority** is a PR that runs the real CI suite and establishes a verdict.
There are two ways to become one: be the head of the stack, or carry the
checkpoint label.

**A segment** is a run of consecutive PRs topped by an authority, extending
downward until it reaches the next authority below.

Every PR belongs to exactly one segment. The authority runs the real suite.
Everyone else runs no CI at all, and the gate copies the authority's verdict onto
them.

```
#6  head          ← authority   ┐
#5                              │ segment A   #6 runs CI; #4 and #5 mirror it
#4                              ┘
#3  [checkpoint]  ← authority   ┐
#2                              │ segment B   #3 runs CI; #1 and #2 mirror it
#1  root                        ┘
```

Two PRs run CI here instead of six. If `#6` goes red, `#4` and `#5` go red with
it, but `#1` through `#3` are untouched, so the bottom half of the stack stays
mergeable. Adding a checkpoint is the one knob that trades CI minutes for merge
independence, and it is opt-in per PR.

There are two moving parts, and keeping them separate is the point:

1. **In your CI workflow**, one step asks whether this PR is an authority. If it
   is not, the workflow exits before any checkout, install, or test run. Your CI
   workflow never posts the required check and does not know that verdicts exist.

2. **Out of band**, a gate workflow resolves the stack, works out what should be
   reported, and posts check runs across the affected PRs.

The gate is triggered by `workflow_run`, and that choice does a lot of work. When
a new head is pushed and its CI completes, the gate wakes up and re-posts fresh
verdicts onto every ancestor in the segment. There is no `repository_dispatch`, no
re-running of parent workflows, and no fan-out of CI. The stale-parent problem
solves itself.

The required check is deliberately **not** a workflow job. A job's status is
permanently bound to the commit of the run that produced it, and cannot be
rewritten later — which is exactly what a parent PR needs when a descendant
changes. Instead the gate writes a check run under a stable name (default
`stack-optimization`) through the Checks API, which it can rewrite on any commit at any
time. Branch protection requires that name. Your CI jobs stay visible for
debugging, but are not required.

---

## Before you rely on this: mirroring and partial merges

**Mirroring is sound for a whole segment. It is not sound for part of one.**

The authority's tree contains every change in every PR beneath it in the same
segment. So when you merge a whole segment, the result is exactly the tree the
authority tested. That is verified.

When you merge only _part_ of a segment, the result is a tree that nothing ever
built. Suppose segment A above is `#4`, `#5`, `#6`, and you merge `#4` and `#5`
while `#6` is still open. Both carry `#6`'s green check — but that check was
earned by a tree that included `#6`'s changes, and you did not merge those.

**So if you intend to merge part of a stack, promote your intended cut point to a
checkpoint first.** Add the `stack-checkpoint` label to it. It will run its own
CI and establish a verdict that genuinely covers the tree you are about to merge.

This is the one place the system trades rigour for speed, and it is worth
choosing knowingly. Everything else here is bookkeeping.

## Before you replace GITHUB_TOKEN

Every action takes a `token` input, so the check can appear under a bot or App
identity instead of the default one. There are two consequences, and the first
one can cost you money.

**Recursion.** Events caused by `GITHUB_TOKEN` do not trigger further workflow
runs, and that is the only thing keeping the gate from looping. If you substitute
a PAT or a GitHub App token, the check runs the gate posts **can** trigger
`check_run` and `check_suite` events. Any workflow of yours listening on those
must guard against re-entry, or you will build an infinite loop that bills you
for every iteration.

**Identity is sticky.** A check run can only be updated by the app that created
it. If you switch `token` to a different identity after the gate has already
written checks, it cannot update those — it creates new ones instead, leaving one
stale duplicate per PR until the next push. Pick an identity before you turn on
branch protection, not after.

---

## Setup

Two files: one edit to your CI workflow, one new workflow.

### 1. Gate your CI workflow

Add a small job that makes the decision, and have your real jobs depend on it.

```yaml
jobs:
  gate-decision:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
      contents: read
    outputs:
      should-run: ${{ steps.d.outputs.should-run }}
    steps:
      - uses: samishal1998/gha-stack-optimization/actions/should-run@v1
        id: d

  test:
    needs: gate-decision
    if: needs.gate-decision.outputs.should-run == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      # ... your existing steps, unchanged
```

Every real job needs `needs: gate-decision` and the same `if:` condition. The
decision job takes a few seconds, so a mirrored PR costs almost nothing.

### 2. Add the gate workflow

```yaml
# .github/workflows/stack-optimization.yml
name: Stack Optimization Gate

on:
  workflow_run:
    workflows: ['CI'] # must match your CI workflow's `name:`, not its filename
    types: [completed]
  pull_request_target:
    types:
      - opened
      - synchronize
      - reopened
      - ready_for_review
      - converted_to_draft
      - labeled
      - unlabeled
      - closed
      - stacked

permissions:
  checks: write
  pull-requests: read
  actions: read
  contents: read

concurrency:
  # Per branch, not repo-wide. See the note below.
  group: >-
    stack-optimization-${{ github.event.workflow_run.head_branch
    || github.event.pull_request.head.ref
    || github.ref }}
  cancel-in-progress: false # a cancelled gate leaves checks half-written

jobs:
  gate:
    uses: samishal1998/gha-stack-optimization/.github/workflows/gate.yml@v1
    with:
      check-name: stack-optimization
      checkpoint-label: stack-checkpoint
```

Three parts of that file are easy to get wrong, so they are worth explaining.

**The `pull_request_target` triggers are not decoration.** `workflow_run` only
fires when CI completes, but several things change a PR's correct verdict without
any CI running: a checkpoint label added mid-flight, a draft flipped to ready, a
parent merged, a PR removed from the stack. These triggers are what make those
take effect. See [Reconciliation](#reconciliation).

**Why `pull_request_target` rather than `pull_request`.** A `pull_request` event
from a fork receives a read-only token no matter what the `permissions:` block
says. The gate could not post a check on a fork PR at all — and if `stack-optimization`
is a required check, that PR would be blocked forever.

The usual danger of `pull_request_target` is checking out and executing PR code
with a privileged token. **This gate never checks out anything.** It reads
metadata only, which is precisely the condition that makes
`pull_request_target` the correct trigger here rather than a liability. See
[Security](#security).

One consequence: `pull_request_target` always runs the version of the workflow
file on your default branch, so changes to it only take effect once merged.

**Why the concurrency group is per branch.** GitHub allows exactly one _pending_
run per concurrency group: when a third run is queued behind a running one, the
second is cancelled to make room. So the choice of group decides which runs get
discarded, and that is the whole reason to think about it.

Grouping per branch means a discarded run is always one that a newer run for the
**same branch** supersedes. The newer run reads fresher state and computes the
same or a better answer, so nothing is lost. This is also where events actually
pile up in practice — rapid pushes and label toggles on one PR.

Grouping repo-wide would be worse, even though it looks safer. A discarded run
could be about a completely unrelated PR, and that PR's verdict would simply never
be written. Trading a narrow problem for a broad one.

The group you would really want is the stack id, so that two PRs in one stack
never write at once. That is not available: concurrency groups are evaluated
before any step runs, and nothing at trigger time identifies the stack — a
`workflow_run` payload carries only the head branch, and a stacked PR's
`base.ref` is its parent's branch, not the stack's target. Two PRs in the same
stack receiving events simultaneously can therefore both write. See
[Limitations](#limitations).

Keep `cancel-in-progress: false`. A gate run cancelled midway leaves checks
half-written.

### 3. Make `stack-optimization` the required check

In branch protection or a ruleset, require the status check named `stack-optimization`.
Leave your CI jobs visible but **not** required: they are for debugging, and the
gate is the contract.

Do this last. Open one stacked PR first, confirm the check appears with the name
you expect, and only then make it required. The guide has a
[safe rollout sequence](GUIDE.md#trying-it-safely-on-a-live-repository) that uses
`dry-run` so a mistake costs a re-run rather than a repository full of blocked
PRs.

---

## What is in the box

Six actions plus a reusable workflow. The reusable workflow is the
batteries-included path and wires three of them together for you. Each action is
independently usable, and the [guide](GUIDE.md#the-actions) documents every input,
output, and behaviour in detail.

| Action                              | What it is for                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| [`should-run`](GUIDE.md#should-run) | Decides whether this PR runs the real CI suite. The one action that goes in your CI workflow. |
| [`context`](GUIDE.md#context)       | Resolves the stack: authorities, segments, who mirrors whom. Pure read, no writes.            |
| [`verdict`](GUIDE.md#verdict)       | Works out which checks should be posted where. Returns a plan and writes nothing.             |
| [`propagate`](GUIDE.md#propagate)   | Executes a plan, with idempotent writes and a staleness guard.                                |
| [`seed`](GUIDE.md#seed)             | Posts the gate check immediately, so a PR is never blocked by a missing check.                |
| [`post-check`](GUIDE.md#post-check) | The raw primitive: create or update one check run on one commit.                              |

If you use the reusable workflow, you need `should-run` and nothing else — the
workflow's PR path already guarantees the check exists, so `seed` is only for
people wiring the pieces up themselves.

---

## The check run contract

| State    | `status`      | `conclusion`      | Meaning                                                               |
| -------- | ------------- | ----------------- | --------------------------------------------------------------------- |
| Seeded   | `queued`      | —                 | Written by `seed`, on a PR that owns its own verdict                  |
| Waiting  | `in_progress` | —                 | Authority identified; its CI is running, or it needs a run of its own |
| Pass     | `completed`   | `success`         | The authority passed                                                  |
| Fail     | `completed`   | `failure`         | The authority failed                                                  |
| Withheld | `completed`   | `action_required` | A verdict was withdrawn; only you can restore it                      |

A check is **always** present on every open PR's head commit. A missing check is
the one state that hard-blocks a merge with no recourse, so it must never happen.

**About the withheld state.** When the gate decides a check can no longer be
trusted — a PR was promoted to checkpoint, or left its stack, so the green it was
carrying was earned by someone else — it wants to put that check back to
`in_progress`. GitHub does not allow it: a `PATCH` moving a completed check run to
a non-terminal status returns `200` and is silently ignored, leaving the old
conclusion in place. So the gate writes `action_required` instead, the only
conclusion that withholds approval. It reads as "you need to do something" rather
than "this failed", the summary says exactly what, and the next real verdict
clears it.

Without this, every invalidation would be cosmetic: the check would go on saying
`success` while the gate had already decided it should not.

When a PR's head commit changes, the new commit **does not inherit** the old
commit's verdict. It starts in a non-verdict state: `queued` if `seed` runs and the
PR owns its own verdict, `in_progress` otherwise. (Only `seed` ever writes
`queued`; the gate itself writes `in_progress` or a conclusion.) When an authority's verdict changes, every
mirroring PR in its segment is rewritten, including from `success` back to
`failure` and back again.

Every check's summary names the authority and links to its run — for example
`Gated by #6 (stack head)` followed by a link to #6's failing CI run. That makes
the system legible from the PR page without reading any of this.

The link is in the summary rather than the check's **Details** button for a
reason worth knowing: GitHub discards `details_url` on check runs created by the
built-in `github-actions` app and substitutes the check run's own page. The gate
still sends it, so it works if you supply a GitHub App token, but nothing may be
promised on the default token — hence the summary.

### Reconciliation

Several things change a PR's correct verdict without any CI running at all. The
`pull_request_target` triggers on the gate workflow handle all of them, by
re-deriving the verdict from the checks already on record. No CI is re-dispatched.

| What changed                                                                      | What the gate does                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkpoint label added                                                            | The promoted PR is now an authority but has never run its own CI. Its inherited check is withdrawn (`action_required`) and its segment withheld until it runs.                                                                                                                        |
| Checkpoint label removed                                                          | The PR rejoins the segment above and mirrors it again.                                                                                                                                                                                                                                |
| Head merged or closed                                                             | The next PR down becomes the head. It is now an authority, but the check it was carrying was mirrored from the PR that just merged, so the gate will not honour it — that PR and everything below it hold at `in_progress` until it runs its own CI. See [Limitations](#limitations). |
| Draft flipped to ready, or to draft                                               | Segment boundaries move (see [`skip-draft-head`](GUIDE.md#skip-draft-head)) and verdicts are re-derived.                                                                                                                                                                              |
| PR removed from the stack                                                         | Its inherited green no longer applies, so the check is withdrawn (`action_required`) with instructions to re-run CI.                                                                                                                                                                  |
| Parent receives a direct push                                                     | The new commit gets an `in_progress` check naming its authority, or immediately re-mirrors that authority's verdict if one is already established. Its own CI still does not run.                                                                                                     |
| **How the gate knows an earned green from an inherited one.** Every check it      |
| writes records its provenance in the check run's `external_id`: whether the       |
| verdict came from this commit's own CI, was mirrored from an authority, or is a   |
| placeholder hold. Without that record, a mirrored `success` would be              |
| indistinguishable from an earned one, and both "this PR left its stack" and "this |
| PR was just promoted to checkpoint" would be unanswerable. A check whose          |
| provenance is missing or unrecognised is never treated as an established verdict. |

---

## Configuration

Every setting can be given as an action input or in an optional config file.
Inputs win over the file; the file wins over the defaults.

```yaml
# .github/stack-optimization.yml
check-name: stack-optimization
checkpoint-label: stack-checkpoint
force-run-label: stack-ci-force

# A PR touching any of these runs its own CI regardless of stack position.
always-run-paths:
  - 'migrations/**'
  - '**/*.sql'

# Report failure on mirroring PRs, or hold them at in_progress instead.
propagate-failures: true

# Treat a draft head as an authority, or fall through to the highest non-draft.
skip-draft-head: true
```

The file is always read from your **default branch**, never from the PR being
evaluated, so a fork PR cannot reconfigure the gate that judges it.

The guide covers what each setting actually does, including the asymmetry that
matters most: for a run forced by `always-run-paths` or `force-run-label`, **a
failure is honoured and a pass is not.** See
[the configuration reference](GUIDE.md#configuration-reference).

---

## Permissions

The default `GITHUB_TOKEN` is enough. `checks: write` permits writing check runs
against **any commit in the same repository**, including commits belonging to
other PRs, which is what makes the whole approach work without a GitHub App or a
PAT.

```yaml
permissions:
  checks: write
  pull-requests: read
  actions: read
  contents: read # reads .github/stack-optimization.yml from the default branch
```

## Security

The gate runs with `checks: write` in the base-repository context and is reachable
from fork PRs through `workflow_run`. Therefore:

- **No `actions/checkout` of the head ref in the gate workflow.** It reads
  metadata only, and never executes code, scripts, or dependencies from the PR
  under evaluation.
- Values read from a PR — title, branch name, label text — are treated as
  untrusted. Check-run summaries are built from PR numbers and commit SHAs, not
  from attacker-controlled strings.
- The config file is read from the default branch, never from the PR.
- Pin these actions to a full commit SHA in your own workflows.

---

## Limitations

- **Cross-repository stacks are not supported.** A fork PR is treated as
  standalone and reports its own CI result.
- Non-native stacking tools (Graphite, `spr`, `ghstack`) are not supported. The
  resolver sits behind a `TopologyProvider` interface, so an adapter is possible
  without touching the decision logic.
- A stack with one open member is reported as not-in-stack. With nothing above or
  below it, there is nothing to mirror, so it runs its own CI.
- **Merging the head of a stack temporarily blocks the rest of it.** The next PR
  down is now an authority, but the check it holds was mirrored from the PR you
  just merged, so the gate will not honour it. That PR and everything below it
  hold at `in_progress` until it runs its own CI. Usually this resolves itself
  within moments, because merging the head restacks the PR below it and that push
  triggers CI — but if its head commit does not move, re-run CI on the new head.
  This is the same invalidation as the checkpoint case below, and exists for the
  same reason: the alternative is honouring a verdict the PR never earned.
- Promoting a PR to checkpoint **temporarily blocks its segment** until that PR
  runs real CI. This is deliberate — the alternative is honouring a verdict it
  never earned — but it is a merge block, so promote before you need to merge.
- **Two PRs in the same stack can be gated at the same time.** The concurrency
  group is per branch, because nothing available at trigger time identifies the
  stack, so simultaneous events on different PRs of one stack are not serialised
  against each other. Each run computes from live state, and any later event
  reconciles, so this is self-correcting rather than persistent — but a check can
  briefly disagree with its authority. GitHub's `concurrency` cannot express
  "one at a time per stack" today.
- `stack-optimization` never restacks or manages branches. `gh stack` owns that.
- It never runs tests. It decides _whether_ CI should run and _what verdict to
  report_.

---

## Development

```bash
npm ci
npm test          # unit and property tests
npm run typecheck
npm run build     # bundles each action into actions/*/dist (committed)
```

`src/topology.ts` and `src/verdict.ts` are pure functions over plain data, with no
network access. That is what makes the whole decision surface testable from
fixtures, and it is where the real risk lives. The property tests point there
too: for any stack and any checkpoint placement, every PR belongs to exactly one
segment and has exactly one authority.

The bundles under `actions/*/dist` are committed, because GitHub Actions runs them
straight from the repository. CI fails if they are out of date.

### Verifying against a real repository

The decision logic is unit-tested, but the event plumbing is not. That needs a
scratch repository with the stacked-PR preview enabled:

1. **Add a head to a stack.** Open a three-PR stack, let it settle green, then
   push a fourth on top. Every ancestor should refresh to the new head's verdict
   with no manual action.
2. **Red head.** Break the head. `#1` to `#3` should go red, with Details
   pointing at the head's failing run.
3. **Checkpoint, then partial merge.** Label `#2` as a checkpoint. It should run
   its own CI. With the head still red, `#1` and `#2` should be mergeable.
4. **Force-push a parent.** Its check should return to a non-verdict state, then
   settle back to the authority's verdict without its own CI running.
5. **Remove a PR from the stack.** Its check should move to `in_progress` with
   instructions, not stay green.

Run the gate with `dry-run: true` first: every plan is logged and nothing is
written.
