# PRD — `stack-gate`

**Composable GitHub Actions for stack-aware CI gating**

Status: Draft
Owner: Sami
Last updated: 2026-08-21

---

## 1. Problem

In a stacked pull request, every PR in the chain runs the full CI suite. For a
five-PR stack, that is five full CI runs where — in a repository that does not
require linear history and merges the stack as a unit — only the head of the
stack meaningfully validates anything. The head contains every change below it.
Everything underneath is burning runner minutes to re-prove a subset of what the
head already proved.

The naive fix ("skip CI on non-head PRs") breaks immediately on the required-check
contract:

1. **Blocked merges.** A required check that never reports leaves the PR pending
   forever. Skipping the workflow is not the same as reporting a pass.
2. **Stale parents.** When a new PR is pushed on top of the stack, the parents'
   workflows do not re-trigger. A parent that was red stays red even though the
   new head is green. Nothing in the `pull_request` event model wakes a parent up
   when a *descendant* changes.
3. **Partial merges.** Teams routinely merge the bottom half of a stack while the
   top is still in review. If the head is red, the bottom half must not inherit
   that failure — it needs an independently-established verdict.

This document specifies a suite of composable actions that solve all three.

---

## 2. Background — native stacked PRs

GitHub shipped stacked pull requests to public preview on 2026-07-30. The
relevant capabilities:

- A `stack` property is attached to the `pull_request` object in webhook event
  payloads, exposing the stack's final target branch rather than just the PR's
  direct base.
- Stack membership and ordering are queryable through the REST API and the
  `gh stack` CLI extension.
- Branch protection is enforced against the stack's final target branch, not the
  direct base.
- CI runs for every PR in the stack as if it targeted the final branch — which is
  precisely the behaviour this project exists to trim.

This means **stack topology does not need to be inferred or declared.** No label
conventions, no body markers, no walking `base_ref` chains heuristically. The
graph is authoritative and comes free in the event payload.

---

## 3. Goals

- Run full CI **once per stack segment** instead of once per PR.
- Keep a single, stable required-check name that is always reported on every PR,
  in every state, so no PR is ever blocked on a missing check.
- Automatically refresh parent verdicts when a descendant's result changes,
  without re-dispatching CI.
- Support merging a stack partially, via an explicit checkpoint mechanism.
- Ship as **small composable actions**, usable as steps inside an existing
  workflow — not as an all-or-nothing framework.
- Work with the default `GITHUB_TOKEN`, while allowing a bot/App token to be
  substituted.

## 4. Non-goals

- Managing or restacking branches. `gh stack` owns that.
- Replacing the CI workflow. This suite decides *whether* CI should run and *what
  verdict to report*; it never runs tests itself.
- Supporting non-native stacking tools (Graphite, spr, ghstack) in v1. The
  topology resolver is isolated behind an interface so a v2 adapter is possible.
- Cross-repository stacks.

---

## 5. Core model — segments and authorities

This is the central abstraction. Everything else follows from it.

> A **checkpoint** is a PR explicitly marked (by label) as owning its own verdict.
>
> An **authority** is a PR that runs real CI and establishes a verdict: the
> **stack head**, or any **checkpoint**.
>
> A **segment** is a maximal contiguous run of PRs whose topmost member is an
> authority, extending downward until (but not including) the next checkpoint
> below.

Every PR in a stack belongs to exactly one segment. Within a segment:

- The authority (top of the segment) runs the real CI suite.
- Every other PR skips CI and **mirrors the authority's verdict**.

Example — a six-PR stack with a checkpoint on `#3`:

```
#6  head          ← authority       ┐
#5                                  │ segment A
#4                                  ┘
#3  [checkpoint]  ← authority       ┐
#2                                  │ segment B
#1  root                            ┘
```

- `#6` and `#3` run CI.
- `#4`, `#5` mirror `#6`.
- `#1`, `#2` mirror `#3`.
- If `#6` goes red, `#4` and `#5` go red. `#1`–`#3` are untouched, so the bottom
  half of the stack remains mergeable. This is exactly the partial-merge
  requirement.

Adding a checkpoint is therefore the single knob that trades CI minutes for merge
independence, and it is opt-in per PR.

### 5.1 Correctness note

Mirroring is sound because the authority's tree is a superset of every PR beneath
it in the same segment. Merging a whole segment produces exactly the tree the
authority tested. Merging *part* of a segment does not, which is why a partial
merge requires promoting the intended cut point to a checkpoint first. This
trade-off must be documented prominently in the README — it is the one place
where the system trades rigour for speed, and users should be choosing it
knowingly.

---

## 6. Architecture

Two moving parts, deliberately decoupled.

### 6.1 In the CI workflow — early exit

A single step at the top of the CI workflow (or a cheap gating job that all other
jobs `needs:`) asks whether this PR is an authority. Non-authorities exit
immediately, before any checkout, dependency install, or test run.

The CI workflow does **not** post the required check. It does not know about
verdicts at all. Its only job is to run tests and finish.

### 6.2 Out of band — the gate workflow

A separate workflow triggered on `workflow_run: [completed]` for the CI workflow.
When any PR's CI finishes, the gate wakes up, resolves the stack, computes a
verdict plan, and posts check runs across the affected PRs.

`workflow_run` is the key architectural choice. It solves the stale-parent
problem for free: when a new head is pushed and its CI completes, the gate fires
and re-posts fresh verdicts onto every ancestor in the segment. No
`repository_dispatch`, no re-running parent workflows, no fan-out of CI.

```
push to #6 ──► CI workflow (#6)  ──completed──► gate workflow
                                                    │
                                        resolve stack, compute plan
                                                    │
                              post check run on #6, #5, #4  (stop at #3)
```

### 6.3 Why a synthetic check run

The required check is **not** a workflow job. A job's status is bound to the SHA
of the run that produced it and cannot be retroactively rewritten. Instead the
gate creates a check run under a stable name (default: `stack-gate`) via the
Checks API. Branch protection requires *that* name.

This gives full control: the gate can write, and rewrite, the verdict on any SHA
in the repository at any time. The stale-parent problem, the partial-merge
problem, and the pending-forever problem all reduce to "post the right check run
on the right SHA," which is a single API call.

CI jobs may remain visible as non-required checks for debugging.

---

## 7. Check run state machine

The gate check on a given PR SHA moves through:

| State | `status` | `conclusion` | Meaning |
|---|---|---|---|
| Seeded | `queued` | — | PR opened/synced; authority not yet resolved |
| Waiting | `in_progress` | — | Authority identified, its CI is running or absent |
| Pass | `completed` | `success` | Authority passed |
| Fail | `completed` | `failure` | Authority failed |
| Detached | `completed` | `neutral` | PR left the stack / authority unresolvable |

Rules:

- A check is **always** present on every open PR's head SHA. Seeding on
  `pull_request: [opened, synchronize, reopened]` guarantees this. A missing
  check is the one state that hard-blocks a merge, so it must never occur.
- When a PR's head SHA changes, the new SHA starts at `queued` and is *not*
  inherited from the old SHA.
- When an authority's verdict changes, every dependent PR in its segment is
  rewritten — including from `success` back to `failure`, and back again.
- `details_url` on a mirrored check points at the **authority's** run, so a red
  parent links directly to the failing head run. The `summary` names the
  authority (`Gated by #6 (stack head)`), which makes the whole system legible
  from the PR UI without reading docs.

---

## 8. Components

Six actions plus one reusable workflow. Each is independently usable; the
reusable workflow is the batteries-included path.

### 8.1 `stack-gate/context`

Resolves stack topology for a PR. Pure read; no side effects. Every other action
consumes its output.

**Inputs**

| Name | Required | Default | Description |
|---|---|---|---|
| `token` | no | `${{ github.token }}` | Needs `pull-requests: read` |
| `pr-number` | no | inferred from event | Target PR |
| `checkpoint-label` | no | `stack-checkpoint` | Label marking a checkpoint |
| `config-path` | no | `.github/stack-gate.yml` | Optional repo config |

**Outputs**

| Name | Type | Description |
|---|---|---|
| `in-stack` | bool | Whether the PR belongs to a stack |
| `stack-id` | string | Stable stack identifier |
| `target-branch` | string | Stack's final target branch |
| `position` | int | 0-indexed from root |
| `size` | int | Number of PRs in the stack |
| `is-head` | bool | Topmost PR in the stack |
| `is-root` | bool | Bottom PR in the stack |
| `is-checkpoint` | bool | Carries the checkpoint label |
| `is-authority` | bool | `is-head \|\| is-checkpoint` |
| `authority-pr` | int | PR number governing this PR's verdict |
| `authority-sha` | string | Head SHA of the authority |
| `segment` | JSON | `[{pr, sha, is_authority}]` for this PR's segment |
| `ancestors` | JSON | All PRs below, root-ward, ordered |
| `descendants` | JSON | All PRs above, head-ward, ordered |
| `stack` | JSON | Full topology, root → head |

Note that `is-authority` is the single output that drives the skip decision, and
`segment` is the single output that drives propagation. Consumers should rarely
need the raw `stack`.

### 8.2 `stack-gate/should-run`

Thin decision layer over `context`. Intended as the first step in the CI
workflow.

**Inputs:** `context` (JSON, optional — resolves internally if omitted),
`force-run-label` (default `stack-ci-force`), `always-run-paths` (glob list),
`token`.

**Outputs:** `should-run` (bool), `reason` (enum:
`not-in-stack | is-head | is-checkpoint | forced-by-label | forced-by-path | mirrors-authority`),
`authority-pr`.

**Logic:** run if not in a stack, if an authority, if force-labelled, or if the
diff touches an `always-run-paths` glob. Otherwise skip.

The escape hatches matter. `always-run-paths` lets a team say "any PR touching
`migrations/` runs its own CI regardless of stack position," which covers the
case where an intermediate state is genuinely dangerous even if the final state
is fine.

### 8.3 `stack-gate/post-check`

Low-level primitive. Creates or updates a check run on a SHA. Every other
check-writing action is built on it, and it is exposed publicly because it is
useful standalone.

**Inputs**

| Name | Required | Default | Description |
|---|---|---|---|
| `token` | no | `${{ github.token }}` | Needs `checks: write` |
| `name` | no | `stack-gate` | Check run name — the required-check name |
| `sha` | yes | — | Target commit |
| `status` | no | `completed` | `queued \| in_progress \| completed` |
| `conclusion` | no | — | Required when `status: completed` |
| `title` | no | — | Check run output title |
| `summary` | no | — | Markdown summary |
| `text` | no | — | Extended markdown detail |
| `details-url` | no | — | Link target |
| `external-id` | no | — | Correlation id |

**Outputs:** `check-run-id`, `created` (bool — false if an existing run was
patched).

**Behaviour:** idempotent on `(name, sha)`. Lists existing check runs for the SHA
filtered by name and PATCHes the most recent match rather than creating
duplicates. A stack that re-propagates ten times must not leave ten check runs on
a parent.

### 8.4 `stack-gate/verdict`

Computes what should be reported, without writing anything. Separating
computation from mutation makes the system testable and enables a dry-run mode.

**Inputs:** `context` (JSON), `conclusion` (the completing run's conclusion),
`run-id`, `run-url`, `token`.

**Outputs:**

- `plan` — JSON array of `{pr, sha, status, conclusion, reason, details_url, summary}`
- `is-authoritative` — whether the completing run establishes a verdict
- `affected-count`

**Algorithm:**

```
ctx = context(PR)

if not ctx.in_stack:
    plan = [ mirror own CI conclusion onto own SHA ]
    return

if ctx.is_authority:
    # Our own CI result is real. Propagate it down our segment.
    verdict = conclusion
    targets = ctx.segment            # includes self, stops before next checkpoint
    plan = [ {pr: t.pr, sha: t.sha, conclusion: verdict, ...} for t in targets ]

else:
    # Our own CI run carries no signal — it was skipped.
    # Report whatever our authority currently says.
    auth = latest_gate_check(ctx.authority_sha)
    if auth is completed:
        plan = [ {pr: self, sha: own_sha, conclusion: auth.conclusion} ]
    else:
        plan = [ {pr: self, sha: own_sha, status: in_progress} ]
```

The critical invariant: **a non-authority's own CI conclusion is never used as its
verdict.** A skipped run concludes `success` (or `skipped`) trivially, and
treating that as a pass would silently defeat the entire gate. The verdict for a
non-authority always derives from the authority, or is `in_progress`.

### 8.5 `stack-gate/propagate`

Executes a plan. Loops over entries and calls the `post-check` primitive.

**Inputs:** `plan` (JSON), `token`, `check-name`, `dry-run` (bool),
`max-concurrency` (default 4).

**Outputs:** `posted` (int), `skipped-stale` (int), `results` (JSON).

**Staleness guard:** before writing to a PR's SHA, re-fetch that PR's current head
SHA and compare against the SHA recorded in the plan. If they differ, the PR moved
while the gate was running — skip it and let its own seed/gate cycle handle it.
Writing a verdict onto a superseded SHA is harmless but confusing; writing a stale
verdict onto a *new* SHA is a correctness bug.

### 8.6 `stack-gate/seed`

Posts the gate check in `queued`/`in_progress` immediately on
`pull_request: [opened, synchronize, reopened, ready_for_review]`. Guarantees the
required check always exists, so a PR is never blocked by a check that never
reported.

**Inputs:** `token`, `check-name`, `context`.
**Outputs:** `check-run-id`, `state`.

Runs in a few seconds; can share the CI workflow or live in its own tiny one.

### 8.7 Reusable workflow — `stack-gate/.github/workflows/gate.yml`

The batteries-included consumer path. Wires `context` → `verdict` → `propagate`
on a `workflow_run` trigger.

```yaml
name: Stack Gate
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

permissions:
  checks: write
  pull-requests: read
  actions: read

concurrency:
  group: stack-gate-${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: false

jobs:
  gate:
    uses: <org>/stack-gate/.github/workflows/gate.yml@v1
    with:
      check-name: stack-gate
      checkpoint-label: stack-checkpoint
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
```

Consumer-side CI change is one step:

```yaml
jobs:
  gate-decision:
    runs-on: ubuntu-latest
    outputs:
      should-run: ${{ steps.d.outputs.should-run }}
    steps:
      - uses: <org>/stack-gate/should-run@v1
        id: d

  test:
    needs: gate-decision
    if: needs.gate-decision.outputs.should-run == 'true'
    runs-on: ubuntu-latest
    steps: [...]
```

---

## 9. Configuration

Optional `.github/stack-gate.yml`, overridable by action inputs:

```yaml
check-name: stack-gate
checkpoint-label: stack-checkpoint
force-run-label: stack-ci-force

always-run-paths:
  - "migrations/**"
  - "**/*.sql"

# Report failure on parents, or hold them in_progress instead
propagate-failures: true

# Treat a draft head as an authority, or fall through to the highest non-draft
skip-draft-head: true
```

---

## 10. Permissions and tokens

The default `GITHUB_TOKEN` is sufficient. `checks: write` is a grantable scope on
the workflow token, and it permits writing check runs against **any SHA in the
same repository** — including SHAs belonging to other PRs. No GitHub App and no
PAT are required for the standard path.

```yaml
permissions:
  checks: write
  pull-requests: read
  actions: read
```

`token` is nonetheless an input on every action, for teams that want the check to
appear under a bot identity, or that have organisation policy restricting the
default token.

**Recursion warning.** Events caused by `GITHUB_TOKEN` do not trigger further
workflow runs, which is what keeps the gate from looping. If a PAT or App token
is substituted, check runs posted by the gate *can* trigger `check_run` and
`check_suite` events. Any consumer workflow listening on those must guard against
re-entry. This needs to be called out loudly in the README, not buried.

---

## 11. Edge cases

| Case | Handling |
|---|---|
| Head PR merged or closed | Next PR down becomes head; its next CI completion re-establishes verdicts. Consider a `pull_request: [closed]` hook to force immediate re-evaluation rather than waiting. |
| New PR pushed on top | New head's CI completes → gate propagates fresh verdicts down the segment. This is the stale-parent fix. |
| Parent PR receives a direct push | Its SHA changes; `seed` posts `queued`; it waits for the authority's next verdict. Its own CI still does not run. |
| PR removed from the stack | `in-stack` is false → gate mirrors the PR's own CI. If CI was skipped, force a re-run or post `neutral` and require manual re-run. **Open question — see §14.** |
| Checkpoint label added mid-flight | Segment boundaries change. The newly-promoted checkpoint has no CI result of its own; it must be re-run. Gate should post `in_progress` and trigger a re-run via `workflow_dispatch`, or instruct the user. |
| Checkpoint label removed | PR rejoins the segment above and mirrors on the next propagation. |
| Two CI runs complete simultaneously | `concurrency` group keyed on stack id serialises gate execution. Do not use `cancel-in-progress` — a cancelled gate leaves checks half-written. |
| CI run concludes `cancelled` / `skipped` | Not a verdict. Leave the check `in_progress`; do not mirror. |
| Draft head | Per `skip-draft-head`, either treat as authority or fall through to the highest non-draft PR. |
| Fork PRs | `workflow_run` executes in the base-repo context with a write-capable token. **Never check out or execute PR code in the gate workflow.** The gate reads metadata only. |
| Stack larger than the API page size | Paginate topology and check-run lookups. |
| Rate limiting | Batch check-run writes with bounded concurrency; back off on secondary rate limits. |

---

## 12. Security

The gate workflow runs with `checks: write` in the base repository context and is
reachable from fork PRs via `workflow_run`. Therefore:

- No `actions/checkout` of the head ref in the gate workflow.
- No execution of any code, script, or dependency from the PR under evaluation.
- Treat all values read from the PR (title, branch name, label text) as untrusted
  when interpolating into check-run markdown or shell.
- Pin the action to a full commit SHA in consumer workflows.

---

## 13. Implementation

**Language:** TypeScript, bundled with `ncc`. `@actions/core`, `@actions/github`,
Octokit. The topology and verdict logic is intricate enough that it needs unit
tests; composite/shell actions would not be testable to the standard this
requires.

**Layout:**

```
stack-gate/
  actions/
    context/       action.yml, src/
    should-run/
    verdict/
    post-check/
    propagate/
    seed/
  src/
    topology.ts    stack resolution + segment computation
    verdict.ts     pure plan computation
    checks.ts      Checks API client, idempotent upsert
    config.ts
  .github/workflows/
    gate.yml       reusable workflow
  test/
```

`topology.ts` and `verdict.ts` are pure functions over plain data — no network.
That makes the entire decision surface unit-testable from fixtures, which is
where the real risk lives.

**Testing:**

- Unit: segment computation over generated stack fixtures (0–10 PRs, checkpoints
  at every position, head at every position).
- Property: for any stack and any checkpoint placement, every PR belongs to
  exactly one segment and has exactly one authority.
- Integration: a scratch repository exercising add-head-to-stack, red-head,
  checkpoint-then-partial-merge, and force-push-parent.

---

## 14. Open questions

1. **PR leaves the stack after skipping CI.** It has no real verdict and its
   authority is gone. Options: post `neutral` and require a manual re-run;
   `workflow_dispatch` a re-run automatically; or hold `in_progress` with a
   summary explaining what to do. Automatic re-dispatch is friendliest but
   reintroduces a dispatch path this design otherwise avoids.
2. **Should `propagate-failures` default true or false?** Marking parents red is
   informative but noisy — a single red head paints the whole segment red. Holding
   them `in_progress` is quieter but hides real breakage.
3. **Root-PR special case.** When the root is the only remaining PR, the stack is
   arguably no longer a stack. Does `in-stack` go false at size 1?
4. **Checkpoint via label vs. `gh stack` native marker.** Labels are available
   today. If the preview later exposes a native per-PR merge-boundary concept,
   migrate to it.

---

## 15. Milestones

| Phase | Scope |
|---|---|
| M1 | `context` + `post-check`. Topology resolution and idempotent check writing, with unit tests. |
| M2 | `verdict` + `propagate` + reusable workflow. Head-only stacks, no checkpoints. Dogfood on one repo. |
| M3 | `seed` + `should-run`. Full CI-skip path. Measure minutes saved. |
| M4 | Checkpoints and segment partitioning. Partial-merge support. |
| M5 | Escape hatches (`always-run-paths`, `force-run-label`), config file, docs, `v1` tag. |

---

## 16. Success criteria

- CI minutes on stacked PRs drop roughly in proportion to average stack depth.
- Zero PRs blocked by a missing or permanently-pending required check.
- Adding a PR to the top of a stack refreshes every parent's verdict with no
  manual intervention.
- A checkpointed bottom half of a stack remains mergeable while the head is red.
- Consumer adoption is one CI workflow edit plus one new workflow file.
