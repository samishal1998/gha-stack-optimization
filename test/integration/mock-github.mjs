/**
 * A mock GitHub REST API, just large enough to run the real action bundles
 * against.
 *
 * @actions/github reads its base URL from GITHUB_API_URL, so pointing an action
 * at this server exercises the shipped bundle end to end — octokit, pagination,
 * the Checks API calls, all of it — with a world we fully control and can assert
 * on afterwards.
 */
import { createServer } from 'node:http';

/**
 * @param {object} world
 * @param {Array} world.prs        [{number, sha, ref, draft, state, merged, labels, files}]
 * @param {object|null} world.stack {number, base, members:[pr numbers]} or null
 * @param {Array} world.checkRuns  [{id, name, head_sha, status, conclusion, external_id, details_url}]
 * @param {string|null} world.configYml
 */
export function startMockGitHub(world) {
  const state = {
    prs: structuredClone(world.prs ?? []),
    stack: structuredClone(world.stack ?? null),
    checkRuns: structuredClone(world.checkRuns ?? []),
    configYml: world.configYml ?? null,
    /** Every write the action performed, in order. */
    writes: [],
    requests: [],
    nextCheckId: 1000,
  };

  const pr = (n) => state.prs.find((p) => p.number === Number(n));

  const prBody = (p) => ({
    number: p.number,
    // Labels ride along on the pull request, which is how the actions read them
    // — the issues endpoint would need a permission nothing else here uses.
    labels: (p.labels ?? []).map((name) => ({ name })),
    state: p.state ?? 'open',
    draft: p.draft ?? false,
    merged: p.merged ?? false,
    merged_at: p.merged ? '2026-08-01T00:00:00Z' : null,
    head: { ref: p.ref ?? `branch-${p.number}`, sha: p.sha },
    base: { ref: p.base ?? 'main' },
    // The `stack` object GitHub attaches to a pull request resource.
    stack:
      state.stack && state.stack.members.includes(p.number)
        ? {
            id: 9000 + state.stack.number,
            number: state.stack.number,
            size: state.stack.members.length,
            position: state.stack.members.indexOf(p.number) + 1, // 1-based, per the API
            base: { ref: state.stack.base ?? 'main', sha: 'basesha' },
          }
        : null,
  });

  const json = (res, code, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '4999',
    });
    res.end(payload);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const q = url.searchParams;
    state.requests.push(`${req.method} ${path}`);

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const m = (re) => re.exec(path);

      // --- pulls.get -----------------------------------------------------
      let g = m(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/);
      if (g && req.method === 'GET') {
        const p = pr(g[1]);
        return p ? json(res, 200, prBody(p)) : json(res, 404, { message: 'Not Found' });
      }

      // --- pulls.listFiles -----------------------------------------------
      g = m(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files$/);
      if (g && req.method === 'GET') {
        const p = pr(g[1]);
        return json(
          res,
          200,
          (p?.files ?? []).map((filename) => ({ filename })),
        );
      }

      // --- pulls.list ----------------------------------------------------
      if (path.match(/^\/repos\/[^/]+\/[^/]+\/pulls$/) && req.method === 'GET') {
        return json(res, 200, state.prs.filter((p) => (p.state ?? 'open') === 'open').map(prBody));
      }

      // --- repos.listPullRequestsAssociatedWithCommit ---------------------
      g = m(/^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/pulls$/);
      if (g && req.method === 'GET') {
        return json(res, 200, state.prs.filter((p) => p.sha === g[1]).map(prBody));
      }

      // --- checks.listForRef ---------------------------------------------
      g = m(/^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/check-runs$/);
      if (g && req.method === 'GET') {
        const name = q.get('check_name');
        const runs = state.checkRuns.filter(
          (c) => c.head_sha === g[1] && (!name || c.name === name),
        );
        return json(res, 200, { total_count: runs.length, check_runs: runs });
      }

      // --- checks.create -------------------------------------------------
      if (path.match(/^\/repos\/[^/]+\/[^/]+\/check-runs$/) && req.method === 'POST') {
        const run = {
          id: state.nextCheckId++,
          name: body.name,
          head_sha: body.head_sha,
          status: body.status,
          conclusion: body.conclusion ?? null,
          external_id: body.external_id ?? null,
          details_url: body.details_url ?? null,
          output: body.output ?? null,
          started_at: new Date(state.nextCheckId * 1000).toISOString(),
        };
        state.checkRuns.push(run);
        state.writes.push({ op: 'create', ...run });
        return json(res, 201, run);
      }

      // --- checks.update -------------------------------------------------
      g = m(/^\/repos\/[^/]+\/[^/]+\/check-runs\/(\d+)$/);
      if (g && req.method === 'PATCH') {
        const run = state.checkRuns.find((c) => c.id === Number(g[1]));
        if (!run) return json(res, 404, { message: 'Not Found' });
        if (world.forbidUpdate) {
          return json(res, 403, { message: 'Resource not accessible by integration' });
        }
        // GitHub will not walk a completed check run back to a non-terminal
        // status: the PATCH succeeds and the status is left alone. Reproduced
        // here, verified against the live API.
        const reopening = run.status === 'completed' && body.status !== 'completed';
        Object.assign(run, {
          status: reopening ? 'completed' : body.status,
          conclusion: reopening ? run.conclusion : (body.conclusion ?? null),
          external_id: body.external_id ?? run.external_id,
          details_url: body.details_url ?? null,
          output: body.output ?? run.output,
        });
        state.writes.push({ op: 'update', ...run });
        return json(res, 200, run);
      }

      // --- stacks: get ---------------------------------------------------
      g = m(/^\/repos\/[^/]+\/[^/]+\/stacks\/(\d+)$/);
      if (g && req.method === 'GET') {
        if (!state.stack || state.stack.number !== Number(g[1])) {
          return json(res, 404, { message: 'Not Found' });
        }
        return json(res, 200, {
          number: state.stack.number,
          base: { ref: state.stack.base ?? 'main' },
          open: true,
          pull_requests: state.stack.members.map((n) => {
            const p = pr(n);
            return {
              number: p.number,
              state: p.state ?? 'open',
              draft: p.draft ?? false,
              merged_at: p.merged ? '2026-08-01T00:00:00Z' : null,
              head: { ref: p.ref ?? `branch-${p.number}`, sha: p.sha },
            };
          }),
        });
      }

      // --- repos.getContent (config file) --------------------------------
      g = m(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
      if (g && req.method === 'GET') {
        if (state.configYml === null) return json(res, 404, { message: 'Not Found' });
        return json(res, 200, {
          type: 'file',
          name: g[1],
          path: g[1],
          encoding: 'base64',
          content: Buffer.from(state.configYml, 'utf8').toString('base64'),
        });
      }

      return json(res, 404, { message: `unmocked: ${req.method} ${path}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
