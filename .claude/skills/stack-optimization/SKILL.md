---
name: stack-optimization
description: Gate a repository's CI so stacked pull requests run the full test suite once per stack segment instead of once per PR, and report a single stable required check on every PR. Use when asked to gate a workflow or action, cut CI costs on stacked PRs, stop re-running CI on every PR in a chain, set up stack-aware CI, or wire up stack-optimization. Handles the CI-workflow edit, the gate workflow, an optional bot identity for the check, the check name, checkpoints for partial merges, and verification before anything is made a required check.
---

# Gating CI for stacked pull requests

In a stacked PR, every PR in the chain runs the full suite. Only the head
meaningfully validates anything — it contains every change below it. This wires
up [stack-optimization](https://github.com/samishal1998/gha-stack-optimization)
so CI runs once per stack segment, while every PR still reports one stable check
so none of them are ever blocked on a check that never arrived.

**Model, in one paragraph.** An *authority* runs real CI and establishes a
verdict: the stack head, plus any PR labelled as a *checkpoint*. A *segment* is a
run of consecutive PRs topped by an authority, extending down to the next
authority. Non-authorities run no CI and mirror their authority's verdict. A
checkpoint is how you keep the bottom half of a stack mergeable while the top is
red — it is the only reason to add one.

## What to establish before editing anything

Ask only for what you cannot determine yourself. Read the repo first.

1. **Which workflow to gate.** Usually the one running tests. Find it with
   `ls .github/workflows/`. If several qualify, ask. Note its `name:` value —
   not its filename — because the gate matches on `name:`.
2. **Check name** — the string that goes into branch protection. Default
   `stack-optimization`. Accept whatever the user wants.
3. **Identity for the check.** Default `GITHUB_TOKEN`, which needs no setup. If
   the user wants the check to appear under a bot or GitHub App, get the secret
   name and read *Bot identity* below before wiring it.
4. **Checkpoint label** — default `stack-checkpoint`. Only rename on request.
5. **Paths that must always run their own CI** — migrations and similar, where an
   *intermediate* state is dangerous even when the final state is fine. Offer
   this; do not invent globs.

Do not ask about `propagate-failures` or `skip-draft-head` unless the user raises
them. The defaults are right for almost everyone.

## Preflight

Stacked PRs are a GitHub preview. Confirm the API is actually available, or
nothing here will work:

```bash
gh api "repos/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/stacks" >/dev/null \
  && echo "stacks API available" || echo "NOT available — stop and tell the user"
```

An empty array `[]` means available with no stacks yet. A 404 means the preview
is not enabled for this repository; say so and stop rather than wiring something
inert.

## Step 1 — gate the CI workflow

Add one decision job, and make every existing job depend on it.

```yaml
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

  test: # every pre-existing job gets these two lines
    needs: gate-decision
    if: needs.gate-decision.outputs.should-run == 'true'
    # ... unchanged
```

Rules that are easy to get wrong:

- **Every** pre-existing job needs both `needs: gate-decision` and the `if:`. A
  job that keeps neither still runs on every PR, and the saving evaporates.
- A job that already has `needs:` gets `gate-decision` appended to the list.
- A job that already has `if:` gets the condition `&&`-joined — and remember an
  existing `if:` without `${{ }}` still needs to remain a single expression.
- Leave `on:` alone. This changes what runs, not when.
- Do not gate jobs that must always run, such as a required lint on every commit.
  Ask if unsure rather than guessing.

If the user asked to gate an **action** rather than a workflow, they mean the
workflow that runs it. Gate the job containing that step, the same way.

## Step 2 — add the gate workflow

Write `.github/workflows/stack-gate.yml`, starting from
`.claude/skills/stack-optimization/reference/gate-workflow.yml`. Substitute the
CI workflow name and, if you are not using a config file, the check name.

Five details in that file matter, and each of them has been a real outage:

- **`workflows: ['CI']` must match the CI workflow's `name:` exactly**, not its
  filename. A mismatch means the gate never fires and the check never appears.
- **`pull_request_target`, not `pull_request`.** A `pull_request` event from a
  fork gets a read-only token regardless of the `permissions:` block, so the gate
  cannot post a check on a fork PR at all — and if the check is required, that PR
  is blocked forever. The gate never checks out PR code, which is the condition
  that makes `pull_request_target` correct here rather than dangerous.
- **All four permissions.** `checks: write`, `pull-requests: read`,
  `actions: read`, `contents: read`. Missing `contents: read` silently disables
  the config file.
- **Concurrency grouped per branch**, `cancel-in-progress: false`. GitHub allows
  one pending run per group; grouping per branch means a dropped run is always
  superseded by a newer one for the same branch. Grouping repo-wide would drop
  runs belonging to unrelated PRs.
- **Never add a `queue:` key.** GitHub rejects the entire workflow file and the
  gate never runs at all.

Keep the `pull_request_target` activity types as given. `labeled` and
`unlabeled` are what make checkpoints take effect; `closed`, `ready_for_review`
and `converted_to_draft` are what keep verdicts correct without re-running CI.

## Step 3 — configuration

Only create `.github/stack-optimization.yml` if something differs from the
defaults. Start from `.claude/skills/stack-optimization/reference/config.yml`
and delete every line you are not changing.

Precedence is **action input, then config file, then built-in default**, so:

- Leave the reusable workflow's `check-name` and `checkpoint-label` inputs
  **unset** if you are setting them in the config file. An input always wins,
  and a workflow input set to the default value silently overrides a config file
  that says something else.
- Set them as workflow inputs instead if there is no config file. Either is fine;
  doing both is how you get a check named one thing while branch protection waits
  for another.

The file is read from the **default branch**, never from the PR under
evaluation.

## Step 4 — verify before requiring anything

Run the linter in this skill. It catches the mistakes above by inspection:

```bash
node .claude/skills/stack-optimization/scripts/verify-gating.mjs
```

Fix everything it reports. Then, in this order:

1. Set `dry-run: true` on the gate workflow job. Merge it. Open or push a stacked
   PR and read the gate's logs — the plan names the PRs and authorities it would
   write, and writes nothing.
2. Remove `dry-run`. Confirm the check appears on every PR in the stack, with the
   head reading `CI passed` and the others `Mirrors #N (passed)`.
3. **Only then** make the check required in branch protection.

Doing it in this order means a mistake costs a re-run instead of a repository of
blocked pull requests. Never make the check required as part of the initial
setup, even if asked — offer to do it as a follow-up once step 2 is confirmed.

## Bot identity for the check

If the user wants the check under a bot or App identity, pass the secret to the
reusable workflow:

```yaml
jobs:
  gate:
    uses: samishal1998/gha-stack-optimization/.github/workflows/gate.yml@v1
    secrets:
      token: ${{ secrets.MY_APP_TOKEN }}
```

Tell them both consequences, plainly, before doing it:

- **Recursion.** Events caused by `GITHUB_TOKEN` do not trigger further workflow
  runs, and that is the only thing keeping the gate from looping. Under a PAT or
  App token, the check runs the gate posts *can* trigger `check_run` and
  `check_suite` events. Any workflow listening on those must guard against
  re-entry or it becomes a billed infinite loop.
- **Identity is sticky.** A check run can only be updated by the app that created
  it. Switching identity later leaves one stale duplicate per PR until the next
  push. Choose before enabling branch protection, not after.

## What is and is not customizable about the check

- **Configurable:** the check name, via `check-name`.
- **Generated:** the title and summary. The gate composes them from PR numbers,
  commit SHAs and the authority's role, and deliberately never interpolates PR
  titles, branch names or label text — those are attacker-controlled on a fork
  PR, and the check is a surface repository members read.
- **Not available:** the check's **Details** link target. GitHub discards
  `details_url` on check runs created by the built-in `github-actions` app and
  substitutes the check run's own page. The gate puts a link to the authority's
  CI run in the summary instead, which survives. Do not promise the user a
  clickable Details target on the default token.

## Checkpoints, and the one unsound case

Mirroring is sound for a **whole** segment and not for **part** of one. The
authority's tree contains every change beneath it, so merging a whole segment
produces exactly the tree that was tested. Merging part of one produces a tree
nothing ever built.

So: whenever the user wants to merge the bottom of a stack while the top is open
or red, tell them to label their intended cut point with the checkpoint label
first. It then runs its own CI and earns a verdict that genuinely covers what
they are merging.

Two behaviours to warn about, because both look like bugs and are not:

- Promoting a PR to checkpoint **withholds its whole segment** until that PR runs
  its own CI. Its inherited check was earned by a different PR, so the gate
  withdraws it (`action_required`) rather than honouring it. Re-run CI on that PR
  to clear it. The same applies to the next PR down when a head merges.
- A withheld check reads `action_required`, not pending. GitHub will not move a
  completed check run back to `in_progress` — that PATCH is accepted and ignored
  — so a conclusion is the only way to actually withhold approval.

## Reporting back

Tell the user: which workflow you edited and which jobs now gate, the exact
string to require in branch protection, whether a config file was created, and
that the check must not be made required until step 4 has been confirmed. If a
bot identity was wired, repeat the recursion warning.

For anything deeper — every action's inputs and outputs, composing the gate by
hand, troubleshooting a stuck check — read
[GUIDE.md](https://github.com/samishal1998/gha-stack-optimization/blob/main/GUIDE.md).
