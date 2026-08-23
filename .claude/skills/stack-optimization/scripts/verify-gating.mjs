#!/usr/bin/env node
/**
 * Lint a repository's stack-optimization wiring.
 *
 * Every check here corresponds to a mistake that produces a silent failure: a
 * gate that never fires, a check that never appears, a saving that never
 * materialises, or a config file that is quietly ignored. Run it before making
 * the check required.
 *
 *   node .claude/skills/stack-optimization/scripts/verify-gating.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WF_DIR = '.github/workflows';
const ACTION = 'gha-stack-optimization';
const problems = [];
const notes = [];
const good = [];

const fail = (m, fix) => problems.push({ m, fix });
const note = (m) => notes.push(m);
const ok = (m) => good.push(m);

/**
 * Strip YAML comments before matching.
 *
 * Without this, a commented-out `# dry-run: true` reads as enabled and a
 * trailing `- labeled # note` fails an end-of-line match. A `#` only starts a
 * comment when it is at line start or preceded by whitespace, and not inside a
 * quoted scalar.
 */
function stripComments(text) {
  return text
    .split('\n')
    .map((line) => {
      let q = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === q) q = null;
        } else if (ch === '"' || ch === "'") {
          q = ch;
        } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
          return line.slice(0, i).replace(/\s+$/, '');
        }
      }
      return line;
    })
    .join('\n');
}

if (!existsSync(WF_DIR)) {
  console.error(`No ${WF_DIR} — run this from the repository root.`);
  process.exit(2);
}

const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
const wf = files.map((f) => {
  const raw = readFileSync(join(WF_DIR, f), 'utf8');
  return { file: f, path: join(WF_DIR, f), raw, text: stripComments(raw) };
});

const nameOf = (t) => (t.match(/^name:\s*(.+?)\s*$/m)?.[1] ?? '').replace(/^['"]|['"]$/g, '');

// ---------------------------------------------------------------------------
// Locate the pieces
// ---------------------------------------------------------------------------
/**
 * A reusable workflow — `workflow_call` and nothing else — is a library, not a
 * consumer's gate. stack-optimization's own gate.yml is one, and so is any copy
 * a repository has vendored. Judging it against consumer rules produces nothing
 * but noise: it has no `workflow_run` list, no PR triggers and no concurrency
 * group, and correctly so, because its caller supplies all three.
 */
const isReusable = (w) =>
  /^\s*workflow_call:/m.test(w.text) &&
  !/^\s*workflow_run:/m.test(w.text) &&
  !/^\s*pull_request(_target)?:/m.test(w.text);

const gates = wf.filter(
  (w) =>
    !isReusable(w) &&
    (w.text.includes(`${ACTION}/.github/workflows/gate.yml`) ||
      w.text.includes(`${ACTION}/actions/verdict`)),
);
const gated = wf.filter((w) => w.text.includes(`${ACTION}/actions/should-run`));

if (gates.length === 0) {
  fail(
    'No gate workflow found.',
    "Add .github/workflows/stack-gate.yml from the skill's reference/gate-workflow.yml.",
  );
}
if (gated.length === 0) {
  fail(
    'No workflow uses actions/should-run, so no CI is actually being skipped.',
    'Add the gate-decision job to the workflow that runs your tests (SKILL.md step 1).',
  );
}

// ---------------------------------------------------------------------------
// The gate workflow
// ---------------------------------------------------------------------------
for (const g of gates) {
  const t = g.text;

  // workflow_run must name an existing workflow by its `name:`
  const listed = [...t.matchAll(/workflows:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')))
    .filter(Boolean);
  if (listed.length === 0) {
    fail(
      `${g.file}: no \`workflows:\` list under workflow_run.`,
      'The gate cannot know which CI run to react to.',
    );
  }
  const names = wf.map((w) => nameOf(w.text)).filter(Boolean);
  for (const l of listed) {
    if (!names.includes(l)) {
      fail(
        `${g.file}: workflow_run watches "${l}", but no workflow has that \`name:\`.`,
        `Existing names: ${names.map((n) => `"${n}"`).join(', ')}. ` +
          'This must match the `name:` value, not the filename — otherwise the gate never fires.',
      );
    } else {
      ok(`${g.file}: watches "${l}", which exists`);
    }
  }

  // pull_request vs pull_request_target
  if (/^\s*pull_request:/m.test(t) && !/pull_request_target:/.test(t)) {
    fail(
      `${g.file}: triggers on \`pull_request\`, not \`pull_request_target\`.`,
      "A fork PR's pull_request token is read-only, so the gate cannot post a check " +
        'and that PR is blocked forever once the check is required.',
    );
  } else if (/pull_request_target:/.test(t)) {
    ok(`${g.file}: uses pull_request_target`);
    for (const need of ['labeled', 'unlabeled', 'closed']) {
      if (!new RegExp(`^\\s*-\\s*${need}\\s*$`, 'm').test(t)) {
        // (t is comment-stripped, so a trailing note does not defeat this)
        note(
          `${g.file}: pull_request_target is missing the \`${need}\` activity type` +
            (need === 'labeled' || need === 'unlabeled'
              ? ' — checkpoints will not take effect until something else happens on the PR.'
              : ' — a merged or closed head will not re-evaluate immediately.'),
        );
      }
    }
  } else {
    note(
      `${g.file}: no PR trigger. Structural changes (checkpoint labels, draft flips, ` +
        'merges) will not be reconciled until CI next completes.',
    );
  }

  // permissions
  const perms = {
    'checks: write': 1,
    'pull-requests: read': 1,
    'actions: read': 1,
    'contents: read': 1,
  };
  const missing = Object.keys(perms).filter((p) => !t.includes(p));
  if (missing.length) {
    fail(
      `${g.file}: missing permissions: ${missing.join(', ')}.`,
      'contents: read is what allows the config file to be read; the rest are required to run at all.',
    );
  } else {
    ok(`${g.file}: all four permissions present`);
  }

  // the queue key GitHub rejects outright
  if (/^\s*queue:\s*/m.test(t)) {
    fail(
      `${g.file}: has a \`queue:\` key under concurrency.`,
      'GitHub rejects the entire workflow file, so the gate never runs. Delete the line.',
    );
  }

  // concurrency shape
  if (!/^concurrency:/m.test(t) && !/^\s{2}concurrency:/m.test(t)) {
    note(`${g.file}: no concurrency group. Two gate runs touching one stack can interleave.`);
  } else {
    if (/cancel-in-progress:\s*true/.test(t)) {
      fail(
        `${g.file}: cancel-in-progress is true.`,
        'A gate cancelled midway leaves checks half-written. Set it to false.',
      );
    } else {
      ok(`${g.file}: concurrency present, cancel-in-progress not true`);
    }
    const grp = t.match(
      /group:\s*(?:>-\s*\n)?([\s\S]*?)(?:\n\s*(?:cancel-in-progress|queue|jobs):)/,
    );
    if (grp && !/github\.event|github\.ref/.test(grp[1])) {
      note(
        `${g.file}: the concurrency group looks constant, which serialises the whole ` +
          'repository. A dropped run may then belong to an unrelated PR. Prefer a per-branch group.',
      );
    }
  }

  // ref pinning
  const refs = [...t.matchAll(new RegExp(`${ACTION}[^@\\s]*@([^\\s'"]+)`, 'g'))].map((m) => m[1]);
  if (refs.some((r) => /^v\d+$/.test(r))) {
    note(
      `${g.file}: pinned to a moving tag (${[...new Set(refs)].join(', ')}). ` +
        'Pin to a full commit SHA for anything you care about.',
    );
  }
}

// ---------------------------------------------------------------------------
// The gated CI workflow: every job must actually be gated
// ---------------------------------------------------------------------------
for (const c of gated) {
  const lines = c.text.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt === -1) continue;

  // Top-level job keys are indented exactly two spaces under `jobs:`.
  const jobs = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (m) jobs.push({ id: m[1], start: i });
    else if (/^\S/.test(lines[i])) break;
  }
  jobs.forEach((j, idx) => {
    j.end = idx + 1 < jobs.length ? jobs[idx + 1].start : lines.length;
    j.body = lines.slice(j.start, j.end).join('\n');
  });

  const decider = jobs.find((j) => j.body.includes(`${ACTION}/actions/should-run`));
  if (!decider) continue;
  ok(`${c.file}: gate-decision job is "${decider.id}"`);

  if (!/outputs:/.test(decider.body) || !/should-run:/.test(decider.body)) {
    fail(
      `${c.file}: job "${decider.id}" does not expose a \`should-run\` output.`,
      'Other jobs cannot branch on it. Add outputs.should-run: ${{ steps.<id>.outputs.should-run }}',
    );
  }
  if (!/pull-requests:\s*read/.test(decider.body) && !/pull-requests:\s*read/.test(c.text)) {
    fail(
      `${c.file}: job "${decider.id}" lacks \`pull-requests: read\`.`,
      'should-run cannot resolve the stack without it.',
    );
  }

  const ungated = jobs.filter((j) => {
    if (j.id === decider.id) return false;
    const needsIt = new RegExp(
      `needs:[^\\n]*\\b${decider.id}\\b|-\\s*${decider.id}\\s*$`,
      'm',
    ).test(j.body);
    const branches = j.body.includes(`needs.${decider.id}.outputs.should-run`);
    return !(needsIt && branches);
  });
  if (ungated.length) {
    fail(
      `${c.file}: ${ungated.length} job(s) are not gated: ${ungated.map((j) => j.id).join(', ')}.`,
      `Each needs \`needs: ${decider.id}\` AND ` +
        `\`if: needs.${decider.id}.outputs.should-run == 'true'\`. ` +
        'Without both, those jobs run on every PR and no CI is saved. ' +
        'If a job is meant to always run, that is fine — confirm it is deliberate.',
    );
  } else if (jobs.length > 1) {
    ok(`${c.file}: all ${jobs.length - 1} other job(s) are gated`);
  }
}

// ---------------------------------------------------------------------------
// Config file, and the precedence trap
// ---------------------------------------------------------------------------
const CFG = '.github/stack-optimization.yml';
if (existsSync(CFG)) {
  const cfg = stripComments(readFileSync(CFG, 'utf8'));
  ok(`${CFG} present`);
  const known = [
    'check-name',
    'checkpoint-label',
    'force-run-label',
    'always-run-paths',
    'propagate-failures',
    'skip-draft-head',
  ];
  for (const m of cfg.matchAll(/^([a-z-]+):/gm)) {
    if (!known.includes(m[1])) note(`${CFG}: unknown key "${m[1]}" — it will be ignored.`);
  }
  for (const key of ['check-name', 'checkpoint-label']) {
    const inCfg = new RegExp(`^${key}:\\s*\\S`, 'm').test(cfg);
    const asInput = gates.some((g) => new RegExp(`^\\s+${key}:\\s*\\S`, 'm').test(g.text));
    if (inCfg && asInput) {
      fail(
        `${key} is set both in ${CFG} and as an input on the gate workflow.`,
        'The input always wins. If they disagree, the gate writes one name while branch ' +
          'protection waits for the other and nothing can merge. Set it in one place.',
      );
    }
  }
} else {
  note(`No ${CFG} — built-in defaults apply. That is fine.`);
}

// ---------------------------------------------------------------------------
if (gates.some((g) => /dry-run:\s*true/.test(g.text))) {
  note(
    'dry-run is on: the gate will log its plan and write nothing. ' +
      'Remove it once the plan looks right, and only then make the check required.',
  );
}

const w = (s) => console.log(s);
if (good.length) {
  w('\nOK');
  good.forEach((g) => w(`  ✓ ${g}`));
}
if (notes.length) {
  w('\nWorth knowing');
  notes.forEach((n) => w(`  • ${n}`));
}
if (problems.length) {
  w('\nProblems');
  problems.forEach((p) => {
    w(`  ✗ ${p.m}`);
    w(`      ${p.fix}`);
  });
  w(`\n${problems.length} problem(s). Do not make the check required until these are fixed.`);
  process.exit(1);
}
w('\nNo problems found. Follow SKILL.md step 4 before making the check required.');
