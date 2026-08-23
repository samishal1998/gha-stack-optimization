/**
 * End-to-end scenarios: the real built bundles, over real HTTP, against a mock
 * GitHub. These cover what the unit tests cannot — that the wiring, the octokit
 * calls, and the check-run writes actually work — and they follow the PRD's
 * integration checklist.
 *
 * Run with: npm run test:integration
 */
import { startMockGitHub } from './mock-github.mjs';
import { runAction } from './run-action.mjs';

const results = [];
let currentScenario = '';

function scenario(name) {
  currentScenario = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  results.push({ scenario: currentScenario, label, ok, actual: a, expected: e });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) console.log(`      expected ${e}\n      actual   ${a}`);
}

function truthy(label, value, why = '') {
  const ok = Boolean(value);
  results.push({ scenario: currentScenario, label, ok, actual: String(value), expected: 'truthy' });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok && why) console.log(`      ${why}`);
}

/** A stack of `n` PRs, root -> head, PR i has sha `sha{i}`. */
function stackOf(n, over = {}) {
  return {
    prs: Array.from({ length: n }, (_, i) => ({
      number: i + 1,
      sha: `sha${i + 1}`,
      ...(over[i + 1] ?? {}),
    })),
    stack: { number: 7, base: 'main', members: Array.from({ length: n }, (_, i) => i + 1) },
    checkRuns: [],
    configYml: null,
  };
}

const CHECK = 'stack-optimization';

/** Read the gate check on a PR's sha out of the mock's final state. */
function checkOn(state, sha) {
  const runs = state.checkRuns.filter((c) => c.head_sha === sha && c.name === CHECK);
  return runs[runs.length - 1] ?? null;
}

function provenanceOf(run) {
  if (!run?.external_id?.startsWith('stack-optimization:')) return null;
  return JSON.parse(run.external_id.slice('stack-optimization:'.length));
}

/** Run verdict then propagate, the way the gate workflow does. */
async function gate(mock, { pr, conclusion, runUrl = 'https://run/1', inputs = {} }) {
  const v = await runAction('verdict', {
    apiUrl: mock.url,
    inputs: { 'pr-number': pr, conclusion, 'run-url': runUrl, ...inputs },
  });
  if (v.failed) return { verdict: v, propagate: null };
  const p = await runAction('propagate', {
    apiUrl: mock.url,
    inputs: {
      plan: v.outputs.plan,
      'check-name': v.outputs['check-name'] || CHECK,
      ...(inputs['dry-run'] ? { 'dry-run': inputs['dry-run'] } : {}),
    },
  });
  return { verdict: v, propagate: p };
}

// ===========================================================================
scenario('1. Head CI passes — the whole segment goes green, once');
{
  const mock = await startMockGitHub(stackOf(3));
  const { verdict, propagate } = await gate(mock, { pr: 3, conclusion: 'success' });

  check('verdict did not fail', verdict.errors, []);
  check(
    'plan covers the whole segment',
    JSON.parse(verdict.outputs.plan).map((e) => e.pr),
    [3, 2, 1],
  );
  check('the completing run was authoritative', verdict.outputs['is-authoritative'], 'true');
  check('propagate wrote three checks', propagate.outputs.posted, '3');
  check('nothing was skipped as stale', propagate.outputs['skipped-stale'], '0');

  for (const [pr, sha] of [
    [3, 'sha3'],
    [2, 'sha2'],
    [1, 'sha1'],
  ]) {
    const run = checkOn(mock.state, sha);
    check(`#${pr} is success`, [run?.status, run?.conclusion], ['completed', 'success']);
  }
  check('the head earned it', provenanceOf(checkOn(mock.state, 'sha3'))?.src, 'own-ci');
  check('#2 inherited it', provenanceOf(checkOn(mock.state, 'sha2'))?.src, 'mirror');
  check('#2 records which PR governs it', provenanceOf(checkOn(mock.state, 'sha2'))?.auth, 3);
  check(
    "#1's details link points at the head's run",
    checkOn(mock.state, 'sha1')?.details_url,
    'https://run/1',
  );
  truthy(
    "#1's summary names the authority",
    checkOn(mock.state, 'sha1')?.output?.summary?.includes('#3'),
  );
  await mock.close();
}

// ===========================================================================
scenario('2. Head CI fails — the segment goes red and links to the failing run');
{
  const mock = await startMockGitHub(stackOf(3));
  await gate(mock, { pr: 3, conclusion: 'failure', runUrl: 'https://run/bad' });
  for (const sha of ['sha3', 'sha2', 'sha1']) {
    check(`${sha} is failure`, checkOn(mock.state, sha)?.conclusion, 'failure');
  }
  check(
    'a parent links to the head run',
    checkOn(mock.state, 'sha1')?.details_url,
    'https://run/bad',
  );
  await mock.close();
}

// ===========================================================================
scenario('3. A gated run on a non-authority must never count as a pass');
{
  // #1 skipped its CI, so the workflow concluded `success` trivially. If the
  // gate honoured that, the whole mechanism would be decorative.
  const mock = await startMockGitHub(stackOf(3));
  const { verdict } = await gate(mock, { pr: 1, conclusion: 'success' });
  const plan = JSON.parse(verdict.outputs.plan);

  check(
    'only #1 is touched',
    plan.map((e) => e.pr),
    [1],
  );
  check('it is not authoritative', verdict.outputs['is-authoritative'], 'false');
  check(
    'it holds rather than passing',
    [plan[0].status, plan[0].conclusion],
    ['in_progress', null],
  );
  check('and it is not recorded as earned', provenanceOf(checkOn(mock.state, 'sha1'))?.src, 'hold');
  await mock.close();
}

// ===========================================================================
scenario('4. Checkpoint splits the stack, so the bottom half stays mergeable');
{
  const world = stackOf(4, { 2: { labels: ['stack-checkpoint'] } });
  const mock = await startMockGitHub(world);

  // The head fails.
  await gate(mock, { pr: 4, conclusion: 'failure' });
  check('#4 red', checkOn(mock.state, 'sha4')?.conclusion, 'failure');
  check('#3 red', checkOn(mock.state, 'sha3')?.conclusion, 'failure');
  check('#2 untouched by the head', checkOn(mock.state, 'sha2'), null);
  check('#1 untouched by the head', checkOn(mock.state, 'sha1'), null);

  // The checkpoint passes on its own.
  await gate(mock, { pr: 2, conclusion: 'success' });
  check('#2 green', checkOn(mock.state, 'sha2')?.conclusion, 'success');
  check('#1 green', checkOn(mock.state, 'sha1')?.conclusion, 'success');
  check('#4 still red', checkOn(mock.state, 'sha4')?.conclusion, 'failure');
  console.log('      → bottom half mergeable while the head is broken');
  await mock.close();
}

// ===========================================================================
scenario('5. A new head refreshes stale parents with no CI re-run');
{
  const mock = await startMockGitHub(stackOf(3));
  await gate(mock, { pr: 3, conclusion: 'failure' });
  check('parents red', checkOn(mock.state, 'sha1')?.conclusion, 'failure');

  // A fourth PR is pushed on top and passes.
  mock.state.prs.push({ number: 4, sha: 'sha4' });
  mock.state.stack.members.push(4);
  await gate(mock, { pr: 4, conclusion: 'success' });

  check('#4 green', checkOn(mock.state, 'sha4')?.conclusion, 'success');
  check('#1 refreshed to green', checkOn(mock.state, 'sha1')?.conclusion, 'success');
  check('#3 refreshed to green', checkOn(mock.state, 'sha3')?.conclusion, 'success');
  check('#1 now answers to #4', provenanceOf(checkOn(mock.state, 'sha1'))?.auth, 4);
  await mock.close();
}

// ===========================================================================
scenario('6. Re-propagating does not pile up duplicate check runs');
{
  const mock = await startMockGitHub(stackOf(3));
  for (let i = 0; i < 3; i++) await gate(mock, { pr: 3, conclusion: 'success' });
  check(
    'one check run per commit, not three',
    ['sha1', 'sha2', 'sha3'].map(
      (s) => mock.state.checkRuns.filter((c) => c.head_sha === s).length,
    ),
    [1, 1, 1],
  );
  check(
    'later writes were updates, not creates',
    mock.state.writes.filter((w) => w.op === 'create').length,
    3,
  );
  await mock.close();
}

// ===========================================================================
scenario('7. A PR that left its stack does not keep its inherited green');
{
  const mock = await startMockGitHub({
    prs: [{ number: 1, sha: 'sha1' }],
    stack: null,
    checkRuns: [
      {
        id: 1,
        name: CHECK,
        head_sha: 'sha1',
        status: 'completed',
        conclusion: 'success',
        external_id:
          'stack-optimization:' +
          JSON.stringify({ v: 1, src: 'mirror', auth: 3, authSha: 'sha3', forced: false }),
        details_url: null,
        started_at: '2026-08-01T00:00:00Z',
      },
    ],
    configYml: null,
  });
  // Reconcile: no conclusion input.
  const { verdict } = await gate(mock, { pr: 1, conclusion: undefined });
  const plan = JSON.parse(verdict.outputs.plan);
  check('it is held, not passed', [plan[0].status, plan[0].conclusion], ['in_progress', null]);
  check('with the reason recorded', plan[0].reason, 'left-stack-needs-own-ci');
  truthy('and instructions in the summary', plan[0].summary.includes('Re-run the CI workflow'));
  // The plan says hold; the write turns that into action_required because the
  // existing check had already completed and GitHub will not reopen it.
  check('the check actually withholds', checkOn(mock.state, 'sha1')?.conclusion, 'action_required');
  await mock.close();
}

// ===========================================================================
scenario('8. Promoting a PR to checkpoint invalidates its inherited check');
{
  const mock = await startMockGitHub({
    ...stackOf(3, { 2: { labels: ['stack-checkpoint'] } }),
    checkRuns: [1, 2].map((n, i) => ({
      id: i + 1,
      name: CHECK,
      head_sha: `sha${n}`,
      status: 'completed',
      conclusion: 'success',
      external_id:
        'stack-optimization:' +
        JSON.stringify({ v: 1, src: 'mirror', auth: 3, authSha: 'sha3', forced: false }),
      details_url: null,
      started_at: '2026-08-01T00:00:00Z',
    })),
  });
  const { verdict } = await gate(mock, { pr: 2, conclusion: undefined });
  const plan = JSON.parse(verdict.outputs.plan);
  check(
    'the new checkpoint and its segment',
    plan.map((e) => e.pr),
    [2, 1],
  );
  check('it is asked to run its own CI', plan[0].reason, 'authority-needs-own-ci');
  check('#2 no longer green', checkOn(mock.state, 'sha2')?.conclusion, 'action_required');
  check('#1 no longer green either', checkOn(mock.state, 'sha1')?.conclusion, 'action_required');
  await mock.close();
}

// ===========================================================================
scenario('9. The staleness guard refuses to write a verdict onto a moved commit');
{
  const mock = await startMockGitHub(stackOf(3));
  const v = await runAction('verdict', {
    apiUrl: mock.url,
    inputs: { 'pr-number': 3, conclusion: 'success', 'run-url': 'https://run/1' },
  });
  // #1 force-pushes between verdict and propagate.
  mock.state.prs.find((p) => p.number === 1).sha = 'sha1-new';

  const p = await runAction('propagate', {
    apiUrl: mock.url,
    inputs: { plan: v.outputs.plan, 'check-name': CHECK },
  });
  check('two written', p.outputs.posted, '2');
  check('one skipped as stale', p.outputs['skipped-stale'], '1');
  check('nothing written to the old commit', checkOn(mock.state, 'sha1'), null);
  check('nor to the new one', checkOn(mock.state, 'sha1-new'), null);
  truthy(
    'the skip is reported',
    JSON.parse(p.outputs.results).some((r) => r.status === 'skipped-stale'),
  );
  await mock.close();
}

// ===========================================================================
scenario('10. The config file is honoured when the workflow passes no name');
{
  // This is the bug that would have blocked every PR: gate.yml forwarding its
  // own default made the config file unreachable.
  const mock = await startMockGitHub({
    ...stackOf(2),
    configYml: 'check-name: ci-gate\ncheckpoint-label: cut-here\n',
  });
  const v = await runAction('verdict', {
    apiUrl: mock.url,
    // Empty strings are exactly what an unset workflow_call input forwards.
    inputs: { 'pr-number': 2, conclusion: 'success', 'check-name': '', 'checkpoint-label': '' },
  });
  check('verdict resolved the configured name', v.outputs['check-name'], 'ci-gate');

  const p = await runAction('propagate', {
    apiUrl: mock.url,
    inputs: { plan: v.outputs.plan, 'check-name': v.outputs['check-name'] },
  });
  check('two checks written', p.outputs.posted, '2');
  check(
    'under the configured name',
    mock.state.checkRuns.map((c) => c.name),
    ['ci-gate', 'ci-gate'],
  );
  check('and not the default', mock.state.checkRuns.filter((c) => c.name === CHECK).length, 0);
  await mock.close();
}

// ===========================================================================
scenario('11. should-run answers correctly at every stack position');
{
  const mock = await startMockGitHub(
    stackOf(4, { 2: { labels: ['stack-checkpoint'] }, 3: { files: ['migrations/001.sql'] } }),
  );
  const expected = {
    4: ['true', 'is-head'],
    2: ['true', 'is-checkpoint'],
    1: ['false', 'mirrors-authority'],
  };
  for (const [pr, [should, reason]] of Object.entries(expected)) {
    const r = await runAction('should-run', { apiUrl: mock.url, inputs: { 'pr-number': pr } });
    check(`#${pr}`, [r.outputs['should-run'], r.outputs.reason], [should, reason]);
  }

  // #3 mirrors #4, but touches migrations/ — the escape hatch applies.
  const forced = await runAction('should-run', {
    apiUrl: mock.url,
    inputs: { 'pr-number': 3, 'always-run-paths': 'migrations/**' },
  });
  check(
    '#3 forced by path',
    [forced.outputs['should-run'], forced.outputs.reason],
    ['true', 'forced-by-path'],
  );
  check('and flagged as forced', forced.outputs.forced, 'true');
  await mock.close();
}

// ===========================================================================
scenario('12. A forced run failure stands over a green authority');
{
  const mock = await startMockGitHub(stackOf(3, { 1: { files: ['migrations/001.sql'] } }));
  await gate(mock, { pr: 3, conclusion: 'success' });
  check('#1 inherited green', checkOn(mock.state, 'sha1')?.conclusion, 'success');

  const { verdict } = await gate(mock, {
    pr: 1,
    conclusion: 'failure',
    inputs: { 'always-run-paths': 'migrations/**' },
  });
  const plan = JSON.parse(verdict.outputs.plan);
  check('its own failure wins', plan[0].conclusion, 'failure');
  check('recorded as its own run', plan[0].reason, 'forced-run-failure');
  check('#1 is now red', checkOn(mock.state, 'sha1')?.conclusion, 'failure');
  check('#3 still green', checkOn(mock.state, 'sha3')?.conclusion, 'success');
  await mock.close();
}

// ===========================================================================
scenario('13. A PR outside any stack reports its own result');
{
  const mock = await startMockGitHub({
    prs: [{ number: 1, sha: 'sha1' }],
    stack: null,
    checkRuns: [],
    configYml: null,
  });
  const { verdict } = await gate(mock, { pr: 1, conclusion: 'failure' });
  const plan = JSON.parse(verdict.outputs.plan);
  check('its own conclusion', plan[0].conclusion, 'failure');
  check('as its own verdict', plan[0].reason, 'not-in-stack-own-ci');
  check('earned, not inherited', provenanceOf(checkOn(mock.state, 'sha1'))?.src, 'own-ci');
  await mock.close();
}

// ===========================================================================
scenario('14. seed always leaves a check, and never clobbers a verdict');
{
  const mock = await startMockGitHub(stackOf(3));
  const head = await runAction('seed', {
    apiUrl: mock.url,
    inputs: { 'pr-number': 3 },
    eventName: 'pull_request',
    event: { pull_request: { number: 3 } },
  });
  check('the authority is queued', head.outputs.state, 'queued');

  const parent = await runAction('seed', {
    apiUrl: mock.url,
    inputs: { 'pr-number': 1 },
    eventName: 'pull_request',
    event: { pull_request: { number: 1 } },
  });
  check('a mirroring PR waits', parent.outputs.state, 'in_progress');
  truthy(
    'and its summary names the authority',
    checkOn(mock.state, 'sha1')?.output?.summary?.includes('#3'),
  );

  // Now a real verdict lands, and a later seed must not erase it.
  await gate(mock, { pr: 3, conclusion: 'success' });
  check('#1 green', checkOn(mock.state, 'sha1')?.conclusion, 'success');
  const again = await runAction('seed', {
    apiUrl: mock.url,
    inputs: { 'pr-number': 1 },
    eventName: 'pull_request',
    event: { pull_request: { number: 1 } },
  });
  check('seed leaves it alone', again.outputs.state, 'completed');
  check('still green', checkOn(mock.state, 'sha1')?.conclusion, 'success');
  await mock.close();
}

// ===========================================================================
scenario('15. A cancelled run is not a verdict');
{
  const mock = await startMockGitHub(stackOf(3));
  const { verdict } = await gate(mock, { pr: 3, conclusion: 'cancelled' });
  check('not authoritative', verdict.outputs['is-authoritative'], 'false');
  check(
    'the segment holds',
    JSON.parse(verdict.outputs.plan).map((e) => e.status),
    ['in_progress', 'in_progress', 'in_progress'],
  );
  await mock.close();
}

// ===========================================================================
scenario('16. dry-run writes nothing');
{
  const mock = await startMockGitHub(stackOf(3));
  const v = await runAction('verdict', {
    apiUrl: mock.url,
    inputs: { 'pr-number': 3, conclusion: 'success' },
  });
  const p = await runAction('propagate', {
    apiUrl: mock.url,
    inputs: { plan: v.outputs.plan, 'check-name': CHECK, 'dry-run': 'true' },
  });
  check('reports what it would do', p.outputs.posted, '3');
  check('but wrote nothing', mock.state.checkRuns.length, 0);
  check('and made no create calls', mock.state.writes.length, 0);
  await mock.close();
}

// ===========================================================================
scenario('17. A merged head hands authority down, and the new head holds');
{
  const mock = await startMockGitHub({
    ...stackOf(3),
    checkRuns: [1, 2].map((n, i) => ({
      id: i + 1,
      name: CHECK,
      head_sha: `sha${n}`,
      status: 'completed',
      conclusion: 'success',
      external_id:
        'stack-optimization:' +
        JSON.stringify({ v: 1, src: 'mirror', auth: 3, authSha: 'sha3', forced: false }),
      details_url: null,
      started_at: '2026-08-01T00:00:00Z',
    })),
  });
  // #3 merges.
  Object.assign(
    mock.state.prs.find((p) => p.number === 3),
    { merged: true, state: 'closed' },
  );

  const { verdict } = await gate(mock, { pr: 2, conclusion: undefined });
  const plan = JSON.parse(verdict.outputs.plan);
  check(
    '#2 is now the head, with #1 below it',
    plan.map((e) => e.pr),
    [2, 1],
  );
  check('it holds until it runs its own CI', plan[0].reason, 'authority-needs-own-ci');
  console.log('      → documented in Limitations: merging the head briefly blocks the rest');
  await mock.close();
}

// ===========================================================================
scenario('18. post-check is idempotent and falls back when it cannot update');
{
  const mock = await startMockGitHub({ prs: [], stack: null, checkRuns: [], configYml: null });
  const a = await runAction('post-check', {
    apiUrl: mock.url,
    inputs: {
      sha: 'abc',
      name: 'custom',
      status: 'completed',
      conclusion: 'success',
      title: 'T',
      summary: 'S',
      'external-id': 'mine',
    },
  });
  check('created', a.outputs.created, 'true');
  const b = await runAction('post-check', {
    apiUrl: mock.url,
    inputs: { sha: 'abc', name: 'custom', status: 'completed', conclusion: 'failure' },
  });
  check('updated, not duplicated', b.outputs.created, 'false');
  check('one run on the commit', mock.state.checkRuns.length, 1);
  check('the caller kept its own external id', mock.state.checkRuns[0].external_id, 'mine');
  await mock.close();

  // A different app owns the existing check: PATCH is refused, so create instead.
  const denied = await startMockGitHub({
    prs: [],
    stack: null,
    configYml: null,
    forbidUpdate: true,
    checkRuns: [
      {
        id: 1,
        name: 'custom',
        head_sha: 'abc',
        status: 'completed',
        conclusion: 'success',
        external_id: null,
        details_url: null,
        started_at: '2026-08-01T00:00:00Z',
      },
    ],
  });
  const c = await runAction('post-check', {
    apiUrl: denied.url,
    inputs: { sha: 'abc', name: 'custom', status: 'completed', conclusion: 'failure' },
  });
  check('falls back to creating', [c.failed, c.outputs.created], [false, 'true']);
  await denied.close();
}

// ===========================================================================
scenario('19. A hold actually withholds, even on a check that already passed');
{
  // GitHub ignores `status: in_progress` on a completed check run. Before this
  // was handled, every invalidation path silently left a green check in place.
  const mock = await startMockGitHub(stackOf(3));
  await gate(mock, { pr: 3, conclusion: 'success' });
  check('#1 starts green', checkOn(mock.state, 'sha1')?.conclusion, 'success');

  // #2 is promoted to checkpoint: its inherited check must stop counting.
  mock.state.prs.find((p) => p.number === 2).labels = ['stack-checkpoint'];
  await gate(mock, { pr: 2, conclusion: undefined });

  const two = checkOn(mock.state, 'sha2');
  check('#2 no longer passes', two?.conclusion, 'action_required');
  check('and it is not left as success', two?.conclusion === 'success', false);
  truthy('its summary explains what to do', two?.output?.summary?.includes('Re-run the CI'));
  check('provenance stays a hold', provenanceOf(two)?.src, 'hold');
  check('#1 is withheld too', checkOn(mock.state, 'sha1')?.conclusion, 'action_required');
  console.log('      → a required check in this state blocks the merge, as intended');
  await mock.close();
}

// ===========================================================================
scenario('20. A PR that left its stack is actually withheld, not just relabelled');
{
  const mock = await startMockGitHub({
    prs: [{ number: 1, sha: 'sha1' }],
    stack: null,
    configYml: null,
    checkRuns: [
      {
        id: 1,
        name: CHECK,
        head_sha: 'sha1',
        status: 'completed',
        conclusion: 'success',
        external_id:
          'stack-optimization:' +
          JSON.stringify({ v: 1, src: 'mirror', auth: 3, authSha: 'sha3', forced: false }),
        details_url: null,
        started_at: '2026-08-01T00:00:00Z',
      },
    ],
  });
  await gate(mock, { pr: 1, conclusion: undefined });
  const one = checkOn(mock.state, 'sha1');
  check('the inherited green is gone', one?.conclusion, 'action_required');
  truthy('with instructions', one?.output?.summary?.includes('Re-run the CI workflow'));
  await mock.close();
}

// ===========================================================================
scenario('21. A real verdict clears a withheld check');
{
  const mock = await startMockGitHub(stackOf(3));
  await gate(mock, { pr: 3, conclusion: 'success' });
  mock.state.prs.find((p) => p.number === 2).labels = ['stack-checkpoint'];
  await gate(mock, { pr: 2, conclusion: undefined });
  check('withheld', checkOn(mock.state, 'sha2')?.conclusion, 'action_required');

  // #2 now runs its own CI as the checkpoint it has become.
  await gate(mock, { pr: 2, conclusion: 'success' });
  check('#2 green again', checkOn(mock.state, 'sha2')?.conclusion, 'success');
  check('and it earned it', provenanceOf(checkOn(mock.state, 'sha2'))?.src, 'own-ci');
  check('#1 follows its new authority', checkOn(mock.state, 'sha1')?.conclusion, 'success');
  check('mirroring #2, not #3', provenanceOf(checkOn(mock.state, 'sha1'))?.auth, 2);
  await mock.close();
}

// ===========================================================================
scenario('22. A workflow run with no pull request behind it is not an error');
{
  // Every push to the default branch produces one of these. Failing would paint
  // the gate red constantly and teach people to ignore it.
  const mock = await startMockGitHub({ prs: [], stack: null, checkRuns: [], configYml: null });
  const wr = {
    workflow_run: {
      id: 123,
      html_url: 'https://x/1',
      conclusion: 'success',
      head_sha: 'nosuchsha',
      head_branch: 'main',
      event: 'push',
      pull_requests: [],
    },
  };
  const ctx = await runAction('context', {
    apiUrl: mock.url,
    event: wr,
    eventName: 'workflow_run',
  });
  check('context succeeds', ctx.failed, false);
  check('and reports no stack', ctx.outputs['in-stack'], 'false');

  const v = await runAction('verdict', { apiUrl: mock.url, event: wr, eventName: 'workflow_run' });
  check('verdict succeeds', v.failed, false);
  check('with an empty plan', v.outputs.plan, '[]');
  check('nothing to propagate', v.outputs['affected-count'], '0');
  check('and nothing was written', mock.state.checkRuns.length, 0);
  await mock.close();
}

// ===========================================================================
const failed = results.filter((r) => !r.ok);
const scenarios = new Set(results.map((r) => r.scenario));
console.log(
  `\n${'='.repeat(70)}\n${results.length - failed.length}/${results.length} assertions passed ` +
    `across ${scenarios.size} scenarios`,
);
if (failed.length) {
  console.log(`\n\x1b[31m${failed.length} FAILED\x1b[0m`);
  for (const f of failed) console.log(`  ${f.scenario}\n    ${f.label}`);
  process.exit(1);
}
console.log('\x1b[32mall green\x1b[0m');
