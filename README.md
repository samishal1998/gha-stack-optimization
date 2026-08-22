# stack-gate

**Composable GitHub Actions for stack-aware CI gating.**

In a stacked pull request, every PR in the chain runs the full CI suite. For a
five-PR stack that is five full runs, where only the head meaningfully validates
anything — the head contains every change below it. Everything underneath is
burning runner minutes to re-prove a subset of what the head already proved.

`stack-gate` runs CI **once per stack segment** instead of once per PR, and
posts a single stable required check on every PR so nothing is ever blocked on a
check that never reported.

Built on GitHub's [native stacked pull requests][native] (public preview), so
stack topology is read from the API rather than inferred from labels, body
markers, or `base_ref` chains.

[native]: https://docs.github.com/en/pull-requests/get-started/about-stacked-prs

---

## How it works

> An **authority** is a PR that runs real CI and establishes a verdict: the
> stack head, or any PR labelled as a **checkpoint**.
>
> A **segment** is a maximal contiguous run of PRs topped by an authority,
> extending downward until (but not including) the next authority below.

Every PR belongs to exactly one segment. The authority runs the real suite;
everyone else skips CI and mirrors the authority's verdict.

```
#6  head          ← authority   ┐
#5                              │ segment A   #6 runs CI; #4, #5 mirror it
#4                              ┘
#3  [checkpoint]  ← authority   ┐
#2                              │ segment B   #3 runs CI; #1, #2 mirror it
#1  root                        ┘
```

If `#6` goes red, `#4` and `#5` go red. `#1`–`#3` are untouched, so the bottom
half of the stack stays mergeable. Adding a checkpoint is the single knob that
trades CI minutes for merge independence, and it is opt-in per PR.

Two moving parts, deliberately decoupled:

1. **In your CI workflow** — one step at the top asks whether this PR is an
   authority. Non-authorities exit before any checkout, install or test run.
   Your CI workflow never posts the required check and knows nothing about
   verdicts.
2. **Out of band** — a gate workflow on `workflow_run: [completed]` resolves the
   stack, computes a verdict plan, and posts check runs across the affected PRs.

`workflow_run` is the load-bearing choice: when a new head is pushed and its CI
completes, the gate re-posts fresh verdicts onto every ancestor in the segment.
No `repository_dispatch`, no re-running parent workflows, no fan-out of CI. That
is the stale-parent problem solved for free.

The required check is **not** a workflow job. A job's status is bound to the SHA
of the run that produced it and cannot be retroactively rewritten. Instead the
gate writes a check run under a stable name (default: `stack-gate`) via the
Checks API, which it can rewrite on any SHA at any time. Branch protection
requires _that_ name.

---

## ⚠️ The one place this trades rigour for speed

**Mirroring is sound for a whole segment. It is not sound for part of one.**

The authority's tree is a superset of every PR beneath it in the same segment, so
merging a whole segment produces exactly the tree the authority tested. Merging
_part_ of a segment does not — those intermediate trees were never built.

If you intend to merge the bottom half of a stack, **promote your intended cut
point to a checkpoint first** (add the `stack-checkpoint` label). It will run its
own CI and establish a verdict that genuinely covers what you are merging.

Choose this knowingly. Everything else in this project is bookkeeping; this is
the actual trade.

## ⚠️ Recursion, if you replace `GITHUB_TOKEN`

Events caused by `GITHUB_TOKEN` do not trigger further workflow runs, which is
what keeps the gate from looping. **If you substitute a PAT or GitHub App token,
the check runs the gate posts _can_ trigger `check_run` and `check_suite`
events.** Any workflow of yours listening on those must guard against re-entry,
or you will build an infinite loop that bills you for it.

A second consequence: a check run can only be updated by the app that created
it. Switching `token` to a different identity mid-flight means the gate cannot
update the checks it previously wrote — it creates new ones instead, leaving one
stale duplicate per PR until the next push. Pick an identity before you enable
branch protection, not after.

---

## Setup

Two files. One edit to your CI workflow, one new workflow.

### 1. Gate your CI workflow

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
      - uses: your-org/stack-gate/actions/should-run@v1
        id: d

  test:
    needs: gate-decision
    if: needs.gate-decision.outputs.should-run == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      # ... your existing steps, unchanged
```

### 2. Add the gate workflow

```yaml
# .github/workflows/stack-gate.yml
name: Stack Gate

on:
  workflow_run:
    workflows: ['CI'] # must match your CI workflow's `name:`
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
  # Serialise every gate run in the repository. See the note below — both parts
  # of this matter.
  group: stack-gate
  cancel-in-progress: false # a cancelled gate leaves checks half-written
  queue: max # without this, queued gate runs are silently dropped

jobs:
  gate:
    uses: your-org/stack-gate/.github/workflows/gate.yml@v1
    with:
      check-name: stack-gate
      checkpoint-label: stack-checkpoint
```

The PR triggers are not decoration. They are what makes a checkpoint label added
mid-flight, a draft flipped to ready, a merged parent, or a PR leaving the stack
take effect without waiting for a CI run. See
[Reconciliation](#reconciliation).

**Why `pull_request_target` and not `pull_request`.** A `pull_request` event from
a fork gets a read-only token no matter what the `permissions:` block says, so
the gate could not post a check on a fork PR — and if `stack-gate` is required,
that PR would be blocked forever. `pull_request_target` runs in the
base-repository context with a writable token.

The usual danger of `pull_request_target` is checking out and executing PR code
with that token. **This gate never checks out anything** — see
[Security](#security). That is precisely the condition under which
`pull_request_target` is the correct trigger rather than a liability.

One consequence worth knowing: `pull_request_target` always runs the workflow
file from your default branch, so changes to this file only take effect once
merged.

**Why the concurrency block is repo-wide, and why `queue: max`.** Two gate runs
touching the same stack must not interleave — one writing #6's fresh verdict
while another writes #4's stale one produces exactly the contradiction the check
exists to prevent. The natural key is the stack id, but concurrency groups are
evaluated before any step runs, and no expression available at trigger time
identifies the stack: `workflow_run` carries only the head branch, and a stacked
PR's `base.ref` is its parent's branch rather than the stack's target. So the
group is the whole repository. Gate runs take seconds and never run tests, so
this costs very little.

`queue: max` is not optional. By default GitHub allows **one** pending run per
concurrency group and cancels any earlier pending one — so under load, gate runs
would be dropped, and a dropped gate run is a verdict that never gets written.
`queue: max` queues up to 100 in FIFO order instead. (It cannot be combined with
`cancel-in-progress: true`, which you do not want here anyway.)

### 3. Make `stack-gate` the required check

In branch protection (or a ruleset), require the status check named
`stack-gate`. Leave your CI jobs visible but **not** required — they are for
debugging; the gate is the contract.

Open one stacked PR before enabling the requirement, so you can see the check
appear and confirm the name matches.

---

## Actions

Six actions plus a reusable workflow. Each is independently usable; the reusable
workflow is the batteries-included path.

| Action                                     | What it does                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| [`actions/context`](actions/context)       | Resolves stack topology: authorities, segments, mirroring relationships. Pure read; every other action consumes its output. |
| [`actions/should-run`](actions/should-run) | The skip decision. First step in your CI workflow.                                                                          |
| [`actions/post-check`](actions/post-check) | Low-level primitive: create or update a check run on a SHA, idempotently.                                                   |
| [`actions/verdict`](actions/verdict)       | Computes what should be reported. Writes nothing.                                                                           |
| [`actions/propagate`](actions/propagate)   | Executes a plan, with a staleness guard and bounded concurrency.                                                            |
| [`actions/seed`](actions/seed)             | Posts the gate check immediately on a PR event, so it always exists.                                                        |

The reusable workflow's PR path already guarantees the check exists, so
`actions/seed` is not needed alongside it. Reach for `seed` directly if you want
the check posted in a couple of seconds from inside your CI workflow — or if you
are wiring the pieces yourself instead of using the reusable workflow.

Each action's `action.yml` documents its inputs and outputs. The two that matter
most: `is-authority` drives the skip decision, and `segment` drives propagation.
Consumers rarely need the raw `stack` output.

`verdict` and `propagate` are separate on purpose. Computation is pure and
unit-tested from fixtures; mutation is a thin loop over the plan. That split is
also what makes `dry-run` worth having — set it on the reusable workflow and the
whole pipeline logs what it would write without touching anything.

---

## Check run states

| State   | `status`      | `conclusion` | Meaning                                                               |
| ------- | ------------- | ------------ | --------------------------------------------------------------------- |
| Seeded  | `queued`      | —            | PR opened or synced; authority not yet resolved                       |
| Waiting | `in_progress` | —            | Authority identified; its CI is running, or it needs a run of its own |
| Pass    | `completed`   | `success`    | Authority passed                                                      |
| Fail    | `completed`   | `failure`    | Authority failed                                                      |

A check is **always** present on every open PR's head SHA. A missing check is
the one state that hard-blocks a merge, so it must never occur.

When a PR's head SHA changes, the new SHA starts at `queued` — it does not
inherit the old SHA's verdict. When an authority's verdict changes, every
dependent PR in its segment is rewritten, including from `success` back to
`failure` and back again.

`details_url` on a mirrored check points at the **authority's** run, so a red
parent links straight to the failing head run. The summary names the authority
(`Gated by #6 (stack head)`), which makes the system legible from the PR UI
without reading these docs.

### Reconciliation

A `workflow_run` trigger only fires when CI completes. Several things change a
PR's correct verdict without any CI running at all:

| Change                              | What the gate does                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkpoint label added              | The promoted PR is now an authority but has never run its own CI. Its inherited check is invalidated and its whole segment is held `in_progress` until it runs. |
| Checkpoint label removed            | The PR rejoins the segment above and mirrors it.                                                                                                                |
| Head merged or closed               | The next PR down becomes head and its verdict re-propagates.                                                                                                    |
| Draft flipped to ready, or to draft | Segment boundaries move (see `skip-draft-head`) and verdicts are re-derived.                                                                                    |
| PR leaves the stack                 | Its inherited green no longer applies. The check is held `in_progress` with instructions to re-run CI.                                                          |
| Parent receives a direct push       | `seed` posts `queued`; it waits for the authority's next verdict. Its own CI still does not run.                                                                |

All of these are handled by the `pull_request` triggers on the gate workflow,
re-deriving the verdict from the checks already on record. No CI is re-dispatched.

**How the gate tells an earned green from an inherited one:** every check it
writes records its provenance in the check run's `external_id` — whether the
verdict came from this SHA's own CI (`own-ci`), was mirrored from an authority
(`mirror`), or is a placeholder hold. Without that, a mirrored `success` would be
indistinguishable from an earned one, and "this PR left its stack" or "this PR
was just promoted to checkpoint" would be unanswerable. A check of unknown
provenance is never treated as an established verdict.

---

## Configuration

Optional `.github/stack-gate.yml`, overridable per-action by inputs. It is always
read from the **default branch**, never from the PR under evaluation — a fork PR
must not be able to reconfigure the gate that judges it.

```yaml
check-name: stack-gate
checkpoint-label: stack-checkpoint
force-run-label: stack-ci-force

# A PR touching any of these runs its own CI regardless of stack position.
always-run-paths:
  - 'migrations/**'
  - '**/*.sql'

# Report failure on mirroring PRs, or hold them in_progress instead.
propagate-failures: true

# Treat a draft head as an authority, or fall through to the highest non-draft.
skip-draft-head: true
```

### Escape hatches

`always-run-paths` and `force-run-label` exist for the case where an
_intermediate_ state is genuinely dangerous even if the final state is fine —
"any PR touching `migrations/` runs its own CI, wherever it sits in the stack."

For a forced run, **a failure is honoured; a pass is not.** A failure there is
real breakage in an intermediate tree, which is the entire point of the hatch. A
pass cannot stand on its own, because a gated run that did no work also
concludes `success` — so a forced pass falls through to the authority's verdict
as usual.

### `skip-draft-head`

With `skip-draft-head: true` (the default), a draft head does not govern the
mergeable part of the stack. Both the head and the highest non-draft PR become
authorities:

```
#6  draft head   ← authority   ┐ segment A
#5  draft                      ┘
#4               ← authority   ┐
#3                             │ segment B
#1, #2                         ┘
```

A work-in-progress head can go as red as it likes without painting `#1`–`#4`.
The drafts still get a verdict from a tree that actually contains their changes.

---

## Permissions

The default `GITHUB_TOKEN` is sufficient. `checks: write` permits writing check
runs against **any SHA in the same repository**, including SHAs belonging to
other PRs. No GitHub App and no PAT are required.

```yaml
permissions:
  checks: write
  pull-requests: read
  actions: read
  contents: read # reads .github/stack-gate.yml from the default branch
```

`token` is nonetheless an input on every action, for teams that want the check to
appear under a bot identity, or whose organisation policy restricts the default
token. Read the [recursion warning](#️-recursion-if-you-replace-github_token)
first.

## Security

The gate workflow runs with `checks: write` in the base-repository context and is
reachable from fork PRs via `workflow_run`. Therefore:

- **No `actions/checkout` of the head ref in the gate workflow.** It reads
  metadata only.
- No execution of any code, script, or dependency from the PR under evaluation.
- Values read from a PR (title, branch name, label text) are treated as
  untrusted. Check-run summaries are built from PR numbers and SHAs, not from
  attacker-controlled strings.
- Pin the actions to a full commit SHA in your workflows.

---

## Limitations

- **Cross-repository stacks are not supported.** A fork PR is treated as
  standalone and reports its own CI result.
- Non-native stacking tools (Graphite, `spr`, `ghstack`) are not supported. The
  topology resolver sits behind a `TopologyProvider` interface, so an adapter is
  possible without touching the decision logic.
- A stack with one open member is reported as not-in-stack: with nothing above or
  below it, there is nothing to mirror, so it runs its own CI.
- Promoting a PR to checkpoint **temporarily blocks its segment** until that PR
  runs real CI. This is deliberate — the alternative is honouring a verdict it
  never earned — but it is a merge block, so promote before you need to merge.
- With more than 100 gate runs pending at once, GitHub drops the overflow and
  those verdicts are not written. Any later event on an affected PR reconciles
  it, but the check can sit stale until then. If you regularly generate that
  much PR traffic, split the gate per target branch and accept the narrower
  serialisation.
- `stack-gate` never restacks or manages branches. `gh stack` owns that.
- It never runs tests. It decides _whether_ CI should run and _what verdict to
  report_.

---

## Development

```bash
npm ci
npm test          # unit + property tests
npm run typecheck
npm run build     # bundles each action into actions/*/dist (committed)
```

`src/topology.ts` and `src/verdict.ts` are pure functions over plain data — no
network — which is what makes the entire decision surface testable from
fixtures. That is where the real risk lives, and where the property tests point:
for any stack and any checkpoint placement, every PR belongs to exactly one
segment and has exactly one authority.

The bundles under `actions/*/dist` are committed, because GitHub Actions runs
them straight from the repository. CI fails if they are out of date.

### Verifying against a real repository

The decision logic is unit-tested, but the event plumbing is not — that needs a
scratch repository with the stacked-PR preview enabled:

1. **Add a head to a stack.** Open a 3-PR stack, let it settle green, push a 4th
   on top. Every ancestor should refresh to the new head's verdict with no
   manual action.
2. **Red head.** Break the head. `#1`–`#3` should go red with `details_url`
   pointing at the head's failing run.
3. **Checkpoint, then partial merge.** Label `#2` as a checkpoint. It should run
   its own CI. With the head still red, `#1` and `#2` should be mergeable.
4. **Force-push a parent.** Its check should return to `queued`, then settle back
   to the authority's verdict without its own CI running.
5. **Remove a PR from the stack.** Its check should go to `in_progress` with
   instructions, not stay green.

Run the gate with `dry-run: true` first: the plans are logged without any check
runs being written.
