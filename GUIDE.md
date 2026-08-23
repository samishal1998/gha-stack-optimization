# stack-optimization guide

This guide covers every action in the suite: what each one is for, when you would
reach for it, and how to wire it up. If you just want the thing working, the
[README quickstart](README.md#setup) is two files and you can stop there. Come
back here when you want to compose the pieces yourself, or when something is
behaving in a way you did not expect.

## Contents

- [The mental model](#the-mental-model)
- [How the actions fit together](#how-the-actions-fit-together)
- [Which actions do you actually need?](#which-actions-do-you-actually-need)
- [The actions](#the-actions)
  - [`context`](#context) — resolve the stack
  - [`should-run`](#should-run) — decide whether to run CI
  - [`verdict`](#verdict) — decide what to report
  - [`propagate`](#propagate) — write the checks
  - [`seed`](#seed) — guarantee the check exists
  - [`post-check`](#post-check) — the raw check-run primitive
- [Configuration reference](#configuration-reference)
- [Recipes](#recipes)
- [Troubleshooting](#troubleshooting)

---

## The mental model

Three definitions carry the whole design. Everything else follows from them.

**An authority** is a pull request that runs the real CI suite and establishes a
verdict. There are two ways to become one: be the head of the stack, or carry the
checkpoint label.

**A segment** is a run of consecutive pull requests topped by an authority,
extending downward until it reaches the next authority below (which belongs to
the next segment down, not this one).

**Mirroring** is what every non-authority does. It runs no CI at all. Instead,
the gate copies its authority's verdict onto it.

Here is a six-PR stack with a checkpoint on `#3`:

```
#6  head          ← authority    ┐
#5                               │  segment A
#4                               ┘
#3  [checkpoint]  ← authority    ┐
#2                               │  segment B
#1  root                         ┘
```

Two PRs run CI: `#6` and `#3`. Four do not: `#4` and `#5` mirror `#6`, while
`#1` and `#2` mirror `#3`.

Why this is safe: `#6` contains every change in `#4` and `#5`, because they sit
below it in the same branch chain. When `#6`'s CI passes, it has already tested a
tree that includes everything `#4` and `#5` contribute. Running their CI
separately would re-prove a subset of what `#6` just proved.

Why the checkpoint matters: if `#6` fails, `#4` and `#5` fail with it, but `#1`
through `#3` are untouched. The bottom half of the stack stays mergeable while
the top half is broken. That is the entire purpose of checkpoints, and it is the
only reason to add one.

### The part you need to be deliberate about

Mirroring is sound for a **whole** segment. It is not sound for **part** of one.

If you merge all of segment A (`#4`, `#5`, `#6`), the resulting tree is exactly
the tree `#6` tested. Verified.

If you merge only `#4` and `#5`, leaving `#6` open, the resulting tree is one
that nothing ever built. `#4` and `#5` carry `#6`'s green check, but that check
was earned by a tree containing `#6`'s changes, which you did not merge.

So: **before merging part of a stack, promote your intended cut point to a
checkpoint.** Label `#5` as a checkpoint, let it run its own CI, and now `#5`'s
green check genuinely covers the tree you are about to merge.

This is the one place the system trades rigour for speed. Everything else is
bookkeeping.

---

## How the actions fit together

There are two separate flows, and keeping them separate is the point of the
design.

### Flow 1: your CI workflow decides whether to run

```
pull_request event
      │
      ▼
┌──────────────┐
│  should-run  │  Am I an authority? Does an escape hatch apply?
└──────┬───────┘
       │
       ├── should-run == true  ──►  run the full test suite
       │
       └── should-run == false ──►  exit immediately, run nothing
```

Your CI workflow does not post the required check. It does not know verdicts
exist. Its only job is to run tests and finish.

### Flow 2: the gate decides what to report

```
CI workflow finishes                Something structural changed
(workflow_run: completed)           (pull_request_target: labeled, …)
        │                                        │
        └──────────────┬─────────────────────────┘
                       ▼
                 ┌───────────┐
                 │  context  │   Resolve the stack. Who is my authority?
                 └─────┬─────┘   What is my segment?
                       ▼
                 ┌───────────┐
                 │  verdict  │   Given what happened and what the existing
                 └─────┬─────┘   checks say, what should be reported where?
                       ▼          Produces a plan. Writes nothing.
                 ┌───────────┐
                 │ propagate │   Execute the plan. One check run per entry.
                 └───────────┘
```

`context` reads. `verdict` thinks. `propagate` writes. The separation is what
makes the decision logic unit-testable without a network, and what makes
`dry-run` meaningful: you can run the whole pipeline and see exactly what it
would have written.

### Why the gate is a separate workflow

A workflow job's status is permanently bound to the commit of the run that
produced it. You cannot go back and change it. That is a problem, because the
verdict for a parent PR needs to change when a *descendant* changes, and nothing
in the `pull_request` event model wakes a parent up when its child moves.

So the required check is not a job. It is a check run that the gate creates
through the Checks API, under a stable name. The gate can write, and rewrite,
that check on any commit in the repository at any time. Three hard problems
collapse into one easy one:

| Problem | Becomes |
|---|---|
| A parent is stale after a new head is pushed | Post the right check on the parent's commit |
| A partial merge needs an independent verdict | Post the right check on the cut point's commit |
| A PR is blocked by a check that never reported | Post *a* check on the commit |

All three are the same API call.

---

## Which actions do you actually need?

Most people need two things, and they are both in the README quickstart:

1. `should-run` in your CI workflow.
2. The reusable `gate.yml` workflow, which runs `context` → `verdict` →
   `propagate` for you.

That is the whole setup. The individual actions are exposed for the cases where
the reusable workflow does not fit:

| If you want to… | Use |
|---|---|
| Just make it work | `should-run` + the reusable `gate.yml` |
| Run the gate steps inline, with your own logging or notifications between them | `context`, `verdict`, `propagate` separately |
| See what the gate *would* do without it writing anything | The reusable workflow with `dry-run: true` |
| Branch your CI workflow on stack position (not just run/skip) | `context` |
| Guarantee the check exists in two seconds, from inside your CI workflow | `seed` |
| Write your own check runs for something unrelated to stacks | `post-check` |

---

## The actions

### `context`

**What it does.** Resolves the stack around a pull request and reports every fact
about its position: who its authority is, which PRs are in its segment, what sits
above and below it. It performs no writes of any kind.

**When you would use it.** Every other action can resolve the context internally,
so you rarely need this on its own. Two cases where you do:

- You want to make your own decisions based on stack position. For example,
  running an expensive integration suite only on the stack head, or posting a
  comment on the root PR.
- You are composing the gate yourself and want the resolved topology available
  to your own steps in between. Pass it to `verdict` so it judges against the
  same view your steps saw. (`propagate` needs no context of its own — it
  consumes `verdict`'s plan.)

**Inputs.**

| Input | Default | Notes |
|---|---|---|
| `token` | `${{ github.token }}` | Needs `pull-requests: read` and `contents: read` |
| `pr-number` | inferred from the event | Set this when the event is not a PR event |
| `checkpoint-label` | `stack-checkpoint` | Overrides the config file |
| `skip-draft-head` | `true` | Overrides the config file |
| `config-path` | `.github/stack-optimization.yml` | Read from the default branch |

**Outputs.**

| Output | Type | Meaning |
|---|---|---|
| `in-stack` | bool | Whether the PR is in a stack with more than one open member |
| `stack-id` | string | The repository's stack number, stable for the stack's life |
| `target-branch` | string | The stack's **final** target branch, not the PR's direct base |
| `position` | int | 0-indexed from the root, counting only open members |
| `size` | int | Number of open members |
| `sha` | string | This PR's head commit |
| `is-head` | bool | Topmost open PR in the stack |
| `is-root` | bool | Bottom open PR in the stack |
| `is-checkpoint` | bool | Carries the checkpoint label |
| `is-authority` | bool | Runs real CI and establishes a verdict |
| `authority-pr` | int | The PR whose verdict governs this one |
| `authority-sha` | string | That PR's head commit |
| `authority-role` | enum | Why it is the authority: `head`, `checkpoint`, or `non-draft-head` |
| `segment` | JSON | `[{pr, sha, is_authority}]`, authority first, then downward |
| `ancestors` | JSON | Open PRs below this one, ordered toward the root |
| `descendants` | JSON | Open PRs above this one, ordered toward the head |
| `stack` | JSON | The full open topology, root to head |
| `context` | JSON | Everything above in one object, for passing to other actions |

Two of these matter far more than the rest. `is-authority` drives the skip
decision. `segment` drives propagation. You will probably never need the raw
`stack` output.

**Behaviour worth knowing.**

Merged and closed PRs are dropped before anything is computed. This is what makes
"the head PR merged" resolve correctly with no special handling: once `#6` merges,
it is no longer in the active set, so `#5` simply *is* the head now, and
`position` and `size` renumber to match.

A stack with only one open member is reported as `in-stack: false`. With nothing
above or below it, there is nothing to mirror and nothing to be an authority
over, so it behaves like an ordinary standalone PR.

**Example: run an expensive suite only on the head.**

```yaml
jobs:
  topology:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
      contents: read
    outputs:
      is-head: ${{ steps.ctx.outputs.is-head }}
      position: ${{ steps.ctx.outputs.position }}
      size: ${{ steps.ctx.outputs.size }}
    steps:
      - uses: samishal1998/gha-stack-optimization/actions/context@v1
        id: ctx

  e2e:
    needs: topology
    if: needs.topology.outputs.is-head == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "Running end-to-end tests on the stack head"
```

---

### `should-run`

**What it does.** Answers one question: should this pull request run the real CI
suite? It is a thin decision layer over `context`, plus the escape hatches.

**When you would use it.** This is the one action that goes in your CI workflow,
and almost everyone needs it. Put it in a small gating job that your real jobs
depend on, so a skipped PR costs one short job instead of a full suite.

**The decision, in order.**

1. Not in a stack → **run**. There is no authority to mirror.
2. Is an authority (head, checkpoint, or the draft-head fallback) → **run**.
3. Carries the force-run label → **run**.
4. Touches a path in `always-run-paths` → **run**.
5. Otherwise → **skip**, and mirror the authority.

**Inputs.**

| Input | Default | Notes |
|---|---|---|
| `token` | `${{ github.token }}` | Needs `pull-requests: read` and `contents: read` |
| `context` | resolved internally | Pass `context`'s output to avoid resolving twice |
| `pr-number` | inferred from the event | |
| `checkpoint-label` | `stack-checkpoint` | Overrides the config file |
| `force-run-label` | `stack-ci-force` | Overrides the config file |
| `always-run-paths` | none | Newline- or comma-separated globs |
| `skip-draft-head` | `true` | Overrides the config file |
| `config-path` | `.github/stack-optimization.yml` | Read from the default branch |

**Outputs.**

| Output | Meaning |
|---|---|
| `should-run` | `true` or `false`. This is the one you branch on. |
| `reason` | Why: `not-in-stack`, `is-head`, `is-checkpoint`, `is-authority`, `forced-by-label`, `forced-by-path`, `mirrors-authority` |
| `authority-pr` | The PR whose verdict this one will mirror, if it skips |
| `forced` | `true` when CI is running because of an escape hatch rather than authority status |

**Behaviour worth knowing.**

The changed-files API call is only made for PRs that would otherwise skip. If a
PR is already going to run CI, `always-run-paths` cannot change that answer, so
the request is skipped. You pay for it only when it can affect the outcome.

`reason: is-authority` (as distinct from `is-head` or `is-checkpoint`) means this
PR is the draft-head fallback: the head is a draft, `skip-draft-head` is on, and
this is the highest non-draft PR. See [`skip-draft-head`](#skip-draft-head).

**Example: the standard gating job.**

```yaml
name: CI
on: pull_request

jobs:
  gate-decision:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
      contents: read
    outputs:
      should-run: ${{ steps.d.outputs.should-run }}
      reason: ${{ steps.d.outputs.reason }}
    steps:
      - uses: samishal1998/gha-stack-optimization/actions/should-run@v1
        id: d

  test:
    needs: gate-decision
    if: needs.gate-decision.outputs.should-run == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npm ci && npm test

  lint:
    needs: gate-decision
    if: needs.gate-decision.outputs.should-run == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npm ci && npm run lint
```

Every real job takes `needs: gate-decision` and the same `if`. The gating job
itself is a few seconds, so a mirrored PR costs almost nothing.

---

### `verdict`

**What it does.** Works out which check runs should exist, on which commits, with
what conclusions. It returns that as a plan and writes nothing at all.

**When you would use it.** Whenever you are running the gate yourself instead of
using the reusable workflow. Also useful on its own if you want to inspect or log
the plan before deciding whether to apply it.

**The two modes.** `verdict` behaves differently depending on whether new CI
information arrived, and the `conclusion` input is what selects the mode:

- **`conclusion` provided** → *CI-completed mode.* A CI run just finished. If
  this PR is an authority, that result is real and gets propagated across its
  segment.
- **`conclusion` omitted** → *reconcile mode.* No new CI ran, but something
  structural changed. The verdict is re-derived from the checks already on
  record. This is how a checkpoint label added mid-flight, or a PR leaving its
  stack, takes effect.

In the reusable workflow this happens automatically: `conclusion` is wired to
`github.event.workflow_run.conclusion`, which is empty on a `pull_request_target`
event, so PR events reconcile and CI completions establish.

The two modes also differ in **how much they rewrite**. A CI completion on a PR
that is not an authority writes only that PR — the event is about its own run. A
reconcile rewrites every non-authority PR in the segment, because structure is a
property of the segment rather than of one PR. Removing a checkpoint is why:
the demoted PR rejoins the segment above, but so does everything that was below
it, and nothing else would ever wake those up.

**Inputs.**

| Input | Default | Notes |
|---|---|---|
| `token` | `${{ github.token }}` | Needs `checks: read`, `pull-requests: read`, `contents: read` |
| `context` | resolved internally | Pass `context`'s output to avoid resolving twice |
| `pr-number` | inferred from the event | Resolved from the run's commit on `workflow_run` |
| `conclusion` | none | The completing CI run's conclusion. **Omit to reconcile.** |
| `run-id` | none | The completing run's id. Logged, for correlation. |
| `run-url` | none | The completing run's `html_url`. Becomes `details_url`. |
| `check-name` | `stack-optimization` | Overrides the config file |
| `checkpoint-label` | `stack-checkpoint` | Overrides the config file |
| `propagate-failures` | `true` | Overrides the config file |
| `skip-draft-head` | `true` | Overrides the config file |
| `config-path` | `.github/stack-optimization.yml` | Read from the default branch |

**Outputs.**

| Output | Meaning |
|---|---|
| `plan` | JSON array of `{pr, sha, status, conclusion, reason, title, summary, details_url, provenance}` |
| `is-authoritative` | `true` when the completing run established a verdict of its own |
| `affected-count` | Number of entries in the plan. `0` means nothing to do. |
| `check-name` | The resolved check name, for passing to `propagate` |

Pass `check-name` from this output into `propagate` rather than setting it twice.
`verdict` reads the config file; `propagate` does not. Threading it through is
what keeps a config-file `check-name` from being silently ignored.

**The rule that matters most.** A non-authority's own CI **pass** is never used as
its verdict. This is not a stylistic choice, it is load-bearing: a workflow whose
jobs were all skipped still concludes `success`. If the gate treated that as a
pass, every mirrored PR would go green regardless of whether anything was ever
tested, and the entire mechanism would be decorative.

So a non-authority's verdict comes from its authority, or it holds — with one
exception. If an escape hatch made the PR run real CI and **that run failed**, its
own failure stands, even over a green authority. A skipped workflow never fails,
so a failure is always real work. See
[the escape hatches](#always-run-paths-and-force-run-label); the short version is
that the hatch can make a PR redder than its authority, never greener.

**A cancelled or skipped run is not a verdict.** Nothing was proven, so the check
holds at `in_progress` rather than reporting anything.

**Example: inspect the plan before applying it.**

```yaml
- uses: samishal1998/gha-stack-optimization/actions/verdict@v1
  id: v
  with:
    conclusion: ${{ github.event.workflow_run.conclusion }}
    run-url: ${{ github.event.workflow_run.html_url }}

- name: Show the plan
  run: echo '${{ steps.v.outputs.plan }}' | jq .

- uses: samishal1998/gha-stack-optimization/actions/propagate@v1
  if: steps.v.outputs.affected-count != '0'
  with:
    plan: ${{ steps.v.outputs.plan }}
    check-name: ${{ steps.v.outputs.check-name }}
```

---

### `propagate`

**What it does.** Takes a plan from `verdict` and writes it. One check run per
entry, created or updated in place.

**When you would use it.** Always paired with `verdict`. It is a separate action
so that computing and writing can be tested, logged, and dry-run independently.

**Inputs.**

| Input | Default | Notes |
|---|---|---|
| `token` | `${{ github.token }}` | Needs `checks: write` and `pull-requests: read` |
| `plan` | **required** | The `plan` output from `verdict` |
| `check-name` | `stack-optimization` | **Does not read the config file.** Pass `verdict`'s `check-name` output. |
| `dry-run` | `false` | Log every write without performing it |
| `max-concurrency` | `4` | Concurrent check-run writes |

**Outputs.**

| Output | Meaning |
|---|---|
| `posted` | Number of check runs written (or that would have been, under `dry-run`) |
| `skipped-stale` | Number of PRs skipped because their head commit moved mid-flight |
| `results` | JSON array of per-entry results, including each check run's id |

**Behaviour worth knowing.**

*Idempotent writes.* Before writing, `propagate` lists the existing check runs on
the target commit under the same name and updates the most recent match rather
than creating a new one. A stack that re-propagates ten times leaves one check
run on each parent, not ten.

*The staleness guard.* Before writing to a PR, `propagate` re-fetches that PR's
current head commit and compares it against the commit recorded in the plan. If
they differ, the PR moved while the gate was running, and it is skipped. This
matters: writing a stale verdict onto a *new* commit would be a correctness bug,
because that commit's code was never tested. The skipped PR is picked up by its
own gate cycle moments later.

*Bounded concurrency.* Writes are capped at `max-concurrency` in flight, and
rate-limited responses are retried with exponential backoff, honouring GitHub's
`Retry-After` header. A deep stack will not trip secondary rate limits.

**Example: dry-run the whole gate.**

Set `dry-run: true` on the reusable workflow and every plan is logged with
nothing written:

```yaml
jobs:
  gate:
    uses: samishal1998/gha-stack-optimization/.github/workflows/gate.yml@v1
    with:
      dry-run: true
```

Do this first, on a real stack, before you make `stack-optimization` a required check.

---

### `seed`

**What it does.** Posts the gate check on a PR's head commit immediately, in a
`queued` or `in_progress` state, so the check always exists.

**Why that matters.** A required check that never reports leaves a PR pending
forever with no way out. Skipping a workflow is not the same as reporting a pass,
and a missing check is the single state that hard-blocks a merge. `seed` exists to
make sure that state never occurs.

**When you would use it.** The reusable workflow's PR path already guarantees
this, so if you use `gate.yml` you do not need `seed`. Reach for it if:

- You are wiring the pieces yourself instead of using the reusable workflow.
- You want the check to appear within seconds of a push, from inside your CI
  workflow, rather than waiting for a separate gate workflow to be scheduled.

**Inputs.**

| Input | Default | Notes |
|---|---|---|
| `token` | `${{ github.token }}` | Needs `checks: write`, `pull-requests: read`, `contents: read` |
| `context` | resolved internally | Pass `context`'s output to avoid resolving twice |
| `pr-number` | inferred from the event | |
| `check-name` | `stack-optimization` | Overrides the config file |
| `checkpoint-label` | `stack-checkpoint` | Overrides the config file |
| `skip-draft-head` | `true` | Overrides the config file |
| `config-path` | `.github/stack-optimization.yml` | Read from the default branch |

**Outputs.**

| Output | Meaning |
|---|---|
| `check-run-id` | Id of the seeded check run |
| `state` | What the check was left as: `queued`, `in_progress`, `completed`, or `skipped` |

**Behaviour worth knowing.**

`seed` never overwrites a completed check. If the commit already has a verdict, it
reports `state: completed` and leaves it alone. Its job is to fill the gap between
"a PR event happened" and "the gate has something to say", not to erase verdicts.

A PR that will mirror an authority is seeded as `in_progress` with a summary
naming that authority, so the PR page explains itself while it waits. A PR that
owns its own verdict is seeded as `queued`.

**Example: seed from inside the CI workflow.**

```yaml
jobs:
  seed:
    runs-on: ubuntu-latest
    permissions:
      checks: write
      pull-requests: read
      contents: read
    steps:
      - uses: samishal1998/gha-stack-optimization/actions/seed@v1
```

This runs in a few seconds and can sit alongside your gating job.

---

### `post-check`

**What it does.** Creates or updates a single check run on a single commit. This
is the primitive that everything else is built on, exposed publicly because it is
genuinely useful on its own.

**When you would use it.** Any time you want to write a check run and do not want
to hand-roll the "list, then create or update" dance. It knows nothing about
stacks and does not need to.

**Inputs.**

| Input | Default | Notes |
|---|---|---|
| `token` | `${{ github.token }}` | Needs `checks: write` |
| `name` | `stack-optimization` | The check run name. This is the name branch protection requires. |
| `sha` | **required** | The commit to write to |
| `status` | `completed` | `queued`, `in_progress`, or `completed` |
| `conclusion` | none | `success`, `failure`, or `neutral`. Required when `status: completed`. |
| `title` | the check name | Output title |
| `summary` | none | Output summary, markdown |
| `text` | none | Extended output detail, markdown |
| `details-url` | none | Where the check's "Details" link goes |
| `external-id` | not written | Your own correlation id. See below. |

**Outputs.**

| Output | Meaning |
|---|---|
| `check-run-id` | Id of the check run created or updated |
| `created` | `false` when an existing check run was updated instead |

**Behaviour worth knowing.**

*Idempotent on `(name, sha)`.* Calling it repeatedly with the same name and commit
updates one check run rather than accumulating duplicates.

*Input validation happens before any API call.* A `completed` status with no
conclusion, or a conclusion outside the allowed set, fails immediately with a
message naming the problem rather than producing an opaque API error.

*About `external-id`.* `post-check` never writes the gate's provenance marker —
it is a general-purpose primitive, and stamping a stack-specific marker onto an
unrelated check would be wrong. If you pass `external-id`, that value is used; if
you do not, the field is left alone entirely, so a correlation id you set on the
first call survives later updates.

The consequence to be aware of: because `post-check` writes no provenance, a
check it creates under the **gate's own check name** reads as unknown provenance,
and the gate will not treat it as an established verdict. That is the safe
direction — it holds rather than trusting a marker it cannot parse — but it means
you should not hand-write the gate's check with this action and expect the gate to
honour it.

**Example: report an external system's result as a check.**

```yaml
- uses: samishal1998/gha-stack-optimization/actions/post-check@v1
  with:
    name: security-scan
    sha: ${{ github.event.pull_request.head.sha }}
    status: completed
    conclusion: ${{ steps.scan.outputs.passed == 'true' && 'success' || 'failure' }}
    title: 'Security scan'
    summary: '${{ steps.scan.outputs.finding-count }} findings'
    details-url: ${{ steps.scan.outputs.report-url }}
```

---

## Configuration reference

Every setting can be given as an action input or in an optional repository config
file. Action inputs win over the file, and the file wins over the defaults.

The file is always read from your repository's **default branch**, never from the
pull request being evaluated. This is deliberate: a fork PR must not be able to
reconfigure the gate that judges it.

```yaml
# .github/stack-optimization.yml

# The check run name. This is what you require in branch protection.
check-name: stack-optimization

# Label that makes a PR a checkpoint: an authority that owns its own verdict.
checkpoint-label: stack-checkpoint

# Label that forces a full CI run regardless of stack position.
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

One caveat: `propagate` and `post-check` do not read this file. `propagate` takes
`check-name` as an input, which is why you should pass `verdict`'s `check-name`
output into it. `post-check` takes `name`. Everything else reads the file.

### `always-run-paths` and `force-run-label`

These exist for a specific situation: an *intermediate* state that is genuinely
dangerous even though the final state is fine. The canonical example is a database
migration. A stack that adds a migration in `#2` and the code using it in `#4` has
a real intermediate state — `#2` merged alone — that nobody tested, because only
`#4` ran CI.

Setting `always-run-paths: ["migrations/**"]` means any PR touching a migration
runs its own suite wherever it sits in the stack.

**For a forced run, a failure is honoured and a pass is not.** This asymmetry is
intentional and worth understanding:

- A **failure** is trustworthy. A skipped workflow never fails, so a failure
  means real work ran and found a real problem in an intermediate tree. That is
  precisely what the hatch exists to catch, so the failure is reported even if the
  authority above is green.
- A **pass** is not trustworthy on its own. A workflow whose jobs were all
  skipped also concludes `success`, and the gate cannot reliably distinguish the
  two after the fact. So a forced pass falls through to the authority's verdict,
  exactly as an unforced PR would.

The practical effect: the hatch can only ever make a PR redder than the authority
says, never greener. That is the safe direction.

### `propagate-failures`

Default `true`: when an authority fails, every mirroring PR in its segment reports
`failure`, with the check's Details link pointing at the authority's failing run.

Set it to `false` and mirroring PRs hold at `in_progress` instead. Quieter, but it
hides real breakage — a broken segment looks like a slow one.

The authority itself always reports its own real conclusion either way. It earned
that result, so this setting never suppresses it. Likewise, a forced run's own
failure is always reported, because it is that PR's own earned result rather than
an inherited one.

### `skip-draft-head`

Default `true`. Consider a stack whose head is a work-in-progress draft:

```
#6  draft head   ← authority     ┐  segment A
#5  draft                        ┘
#4               ← authority     ┐
#3                               │  segment B
#2                               │
#1  root                         ┘
```

With `skip-draft-head: true`, two PRs become authorities: the head `#6`, and `#4`
as the highest non-draft PR. The result is that `#6` can be as broken as a draft
deserves to be without turning `#1` through `#4` red. Meanwhile `#5`, which sits
above `#4` and contains changes `#4` does not, mirrors `#6` rather than `#4` — so
it is still governed by a tree that actually contains its changes.

With `skip-draft-head: false`, only `#6` is an authority and the entire stack
mirrors the draft head.

When the highest non-draft PR is the authority, `context` reports
`authority-role: non-draft-head` and `should-run` reports `reason: is-authority`,
so you can tell this case apart from a head or a checkpoint.

---

## Recipes

### Running the gate steps yourself

If you want to insert your own steps into the gate, skip the reusable workflow and
compose the three actions. This is equivalent to what `gate.yml` does:

```yaml
name: Stack Optimization Gate
on:
  workflow_run:
    workflows: ['CI']
    types: [completed]
  pull_request_target:
    types:
      [
        opened,
        synchronize,
        reopened,
        ready_for_review,
        converted_to_draft,
        labeled,
        unlabeled,
        closed,
        stacked,
      ]

permissions:
  checks: write
  pull-requests: read
  actions: read
  contents: read

concurrency:
  group: >-
    stack-optimization-${{ github.event.workflow_run.head_branch
    || github.event.pull_request.head.ref
    || github.ref }}
  cancel-in-progress: false

jobs:
  gate:
    if: >-
      github.event_name != 'workflow_run' ||
      github.event.workflow_run.conclusion != 'cancelled'
    runs-on: ubuntu-latest
    steps:
      - uses: samishal1998/gha-stack-optimization/actions/context@v1
        id: context

      - uses: samishal1998/gha-stack-optimization/actions/verdict@v1
        id: verdict
        with:
          context: ${{ steps.context.outputs.context }}
          conclusion: ${{ github.event.workflow_run.conclusion }}
          run-url: ${{ github.event.workflow_run.html_url }}

      # Your own step, with the plan available to it.
      - name: Notify on a newly red segment
        if: steps.verdict.outputs.is-authoritative == 'true'
        run: ./scripts/notify.sh '${{ steps.verdict.outputs.plan }}'

      - uses: samishal1998/gha-stack-optimization/actions/propagate@v1
        if: steps.verdict.outputs.affected-count != '0'
        with:
          plan: ${{ steps.verdict.outputs.plan }}
          check-name: ${{ steps.verdict.outputs.check-name }}
```

Three details to keep if you write your own: pass `context` into `verdict` so both
see the same topology; pass `verdict`'s `check-name` into `propagate` so a
config-file name is not ignored; and keep the `concurrency` block, including
the `concurrency` block, whose grouping is explained in the
[README](README.md#2-add-the-gate-workflow).

### More than one CI workflow

`workflow_run` accepts a list. The gate does not care which workflow finished; it
recomputes from whatever the checks currently say:

```yaml
on:
  workflow_run:
    workflows: ['CI', 'Integration', 'Build']
    types: [completed]
```

Note that each completion triggers a gate run, and the last one to finish
determines the final state. If you need the verdict to reflect *all* of them
together, aggregate them into one workflow instead.

### A different check name

Set it once in the config file and let it flow:

```yaml
# .github/stack-optimization.yml
check-name: ci-gate
```

Then require `ci-gate` in branch protection. The reusable workflow picks this up:
**leave its `check-name` input unset** and the config file wins. This is why
`gate.yml`'s inputs deliberately carry no defaults — a default would be forwarded
as a real value, and an action input always beats the config file, so the gate
would write `stack-optimization` while branch protection waited for `ci-gate`.

If you would rather set it as an input, set it on the reusable workflow, and it
overrides the file:

```yaml
jobs:
  gate:
    uses: samishal1998/gha-stack-optimization/.github/workflows/gate.yml@v1
    with:
      check-name: ci-gate
```

### Posting a check under a bot identity

Every action takes a `token`. Pass an App or PAT token and the check appears under
that identity. Read [the recursion
warning](README.md#before-you-replace-github_token) before you do —
there are two real consequences, and one of them is an infinite loop.

### Trying it safely on a live repository

1. Add the gate workflow with `dry-run: true`. Nothing is written.
2. Open a three-PR stack. Watch the gate's logs and confirm the plans name the
   PRs you expect, with the authority you expect.
3. Add `should-run` to your CI workflow. Confirm that non-head PRs skip.
4. Turn `dry-run` off. Confirm the checks appear on all three PRs.
5. Only now make the check required in branch protection.

Doing it in this order means a mistake at any step costs you a re-run, not a
repository full of blocked pull requests.

---

## Troubleshooting

### A PR's check says `action_required`

The gate withdrew a verdict it decided not to trust, and only you can restore it.
This is not a failure — the summary says which case it is, and the answer is
usually to re-run CI on that PR.

It appears as a conclusion rather than a pending state because GitHub will not
move a completed check run back to `in_progress`; that `PATCH` is accepted and
ignored. `action_required` is the only conclusion that withholds approval, so it
is what the gate uses when a completed check has to stop counting. The next real
verdict overwrites it.

### A PR's check is stuck at `in_progress`

Read the check's summary first. It says which case you are in, and there are
several legitimate ones:

| Summary says | What happened | What to do |
|---|---|---|
| `Gated by #N, which has not established a verdict yet` | The authority's CI has not finished, or has not run since the last push | Wait, or check on `#N` |
| `This PR now owns its own verdict … but the check it carried was inherited` | You just added a checkpoint label. The PR has never run its own CI. | Re-run CI on that PR |
| `This PR is no longer part of a stack, and the check it previously carried was inherited` | The PR left its stack. Its green came from an authority that no longer governs it. | Re-run CI, or push a commit |
| `The CI run concluded X, which is not a verdict` | The run was cancelled or skipped entirely | Re-run CI |

In every one of these, the gate is refusing to report a verdict it cannot
justify. Holding is the deliberate choice: the alternative is reporting a pass
that nothing earned.

### A PR has no `stack-optimization` check at all

The gate has never run for that commit. Usual causes:

- **The gate workflow is not installed**, or its `workflows:` list does not match
  your CI workflow's `name:` exactly. This is the most common one. The value in
  `workflows: ['CI']` must match the `name: CI` line in your CI workflow, not its
  filename.
- **The gate workflow file is not on your default branch.** `pull_request_target`
  and `workflow_run` both read the workflow file from the default branch only.
- **The gate run failed.** Check the Actions tab for a failed "Stack Optimization Gate" run.
- **The gate run was dropped by the concurrency queue**, which needs more than
  100 pending runs. Any subsequent event on the PR reconciles it.

Adding `seed` to your CI workflow closes the timing gap, because it posts the
check within seconds of the push rather than after CI finishes.

### Two `stack-optimization` checks on the same PR

You changed the `token` identity. A check run can only be updated by the app that
created it, so the gate could not update the check it wrote under the old identity
and created a new one instead. The stale duplicate disappears on the next push,
since a new commit gets a fresh check. Pick an identity before you enable branch
protection.

### A parent went red and I do not know why

Follow the check's Details link. On a mirrored check it points at the
**authority's** failing run, not at the parent's own. The summary names the
authority too, for example `Gated by #6 (stack head)`. The parent is red because
`#6` is red; fix `#6` and every mirroring PR turns green on the next gate run,
with no action needed on the parents.

If you need the bottom of the stack mergeable while `#6` is still broken, add a
checkpoint label to your intended cut point.

### CI is running on PRs that should be skipping

Check `should-run`'s `reason` output in the job log. It always says exactly why:

- `not-in-stack` — the PR is not in a stack, or is the only open member left.
  A one-member stack is treated as standalone by design.
- `is-head` / `is-checkpoint` / `is-authority` — it is an authority and is
  supposed to run.
- `forced-by-label` — it carries the force-run label.
- `forced-by-path` — its diff touches an `always-run-paths` glob.

If the reason is `mirrors-authority` and CI still ran, your real jobs are missing
the `if: needs.gate-decision.outputs.should-run == 'true'` condition.

### The gate is not reacting to a checkpoint label

The `pull_request_target` trigger needs `labeled` and `unlabeled` in its `types:`
list. Without them, adding a checkpoint label has no effect until something else
happens on the PR. Compare your trigger list against the
[quickstart](README.md#2-add-the-gate-workflow).

### Everything is green but I do not believe it

Confirm the mirrored checks name an authority you expect, then confirm that
authority genuinely ran CI. On the authority's PR, the summary reads `This PR is
the … of its segment and ran the real CI suite`, and its Details link goes to its
own run.

If you are about to merge part of a segment rather than all of it, your suspicion
is correct and the answer is in [the part you need to be deliberate
about](#the-part-you-need-to-be-deliberate-about).
