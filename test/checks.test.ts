import { describe, expect, it, vi } from 'vitest';
import {
  ChecksClient,
  decodeProvenance,
  encodeProvenance,
  mapWithConcurrency,
  withRetry,
} from '../src/checks.js';
import type { Octokit } from '../src/github.js';
import type { PlanEntry, Provenance } from '../src/types.js';

const REPO = { owner: 'acme', repo: 'widgets' };

function provenance(over: Partial<Provenance> = {}): Provenance {
  return { v: 1, src: 'mirror', auth: 6, authSha: 'a'.repeat(40), forced: false, ...over };
}

function entry(over: Partial<PlanEntry> = {}): PlanEntry {
  return {
    pr: 4,
    sha: 'b'.repeat(40),
    status: 'completed',
    conclusion: 'success',
    reason: 'mirrors-authority',
    title: 'Mirrors #6',
    summary: 'Gated by #6.',
    details_url: 'https://example.test/run/1',
    provenance: provenance(),
    ...over,
  };
}

interface CheckRunStub {
  id: number;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  external_id: string | null;
  started_at: string | null;
}

function fakeOctokit(opts: { existing?: CheckRunStub[]; onUpdate?: () => never }): {
  octokit: Octokit;
  calls: { list: unknown[]; create: unknown[]; update: unknown[] };
} {
  const calls = { list: [] as unknown[], create: [] as unknown[], update: [] as unknown[] };
  const octokit = {
    rest: {
      checks: {
        listForRef: vi.fn(async (params: unknown) => {
          calls.list.push(params);
          return { data: { check_runs: opts.existing ?? [] } };
        }),
        create: vi.fn(async (params: unknown) => {
          calls.create.push(params);
          return { data: { id: 999 } };
        }),
        update: vi.fn(async (params: unknown) => {
          calls.update.push(params);
          if (opts.onUpdate) opts.onUpdate();
          return { data: { id: (params as { check_run_id: number }).check_run_id } };
        }),
      },
    },
  } as unknown as Octokit;
  return { octokit, calls };
}

function run(over: Partial<CheckRunStub> = {}): CheckRunStub {
  return {
    id: 11,
    status: 'completed',
    conclusion: 'success',
    details_url: null,
    external_id: encodeProvenance(provenance({ src: 'own-ci' })),
    started_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

describe('provenance encoding', () => {
  it('round-trips', () => {
    const p = provenance({ src: 'own-ci', forced: true });
    expect(decodeProvenance(encodeProvenance(p))).toEqual(p);
  });

  it('treats anything it did not write as unknown', () => {
    expect(decodeProvenance(null)).toBeNull();
    expect(decodeProvenance(undefined)).toBeNull();
    expect(decodeProvenance('')).toBeNull();
    expect(decodeProvenance('some-other-tool-id')).toBeNull();
    expect(decodeProvenance('stack-optimization:not json')).toBeNull();
    expect(decodeProvenance('stack-optimization:{"v":2,"src":"own-ci"}')).toBeNull();
    expect(decodeProvenance('stack-optimization:{"v":1,"src":"bogus"}')).toBeNull();
    expect(decodeProvenance('stack-optimization:null')).toBeNull();
  });

  it('normalises missing fields rather than trusting them', () => {
    const p = decodeProvenance('stack-optimization:{"v":1,"src":"own-ci"}');
    expect(p).toEqual({ v: 1, src: 'own-ci', auth: null, authSha: null, forced: false });
  });

  it('stays well inside the external_id length limit', () => {
    const encoded = encodeProvenance(provenance({ authSha: 'f'.repeat(40) }));
    expect(encoded.length).toBeLessThan(255);
  });
});

describe('ChecksClient.read', () => {
  it('returns null when the SHA has no gate check', async () => {
    const { octokit } = fakeOctokit({});
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    expect(await client.read('c'.repeat(40))).toBeNull();
  });

  it('filters by check name so unrelated checks are invisible', async () => {
    const { octokit, calls } = fakeOctokit({ existing: [run()] });
    const client = new ChecksClient(octokit, REPO, 'my-gate');
    await client.read('c'.repeat(40));
    expect(calls.list[0]).toMatchObject({ check_name: 'my-gate', filter: 'latest' });
  });

  it('picks the most recently started run', async () => {
    const { octokit } = fakeOctokit({
      existing: [
        run({ id: 1, started_at: '2026-08-01T00:00:00Z', conclusion: 'failure' }),
        run({ id: 2, started_at: '2026-08-02T00:00:00Z', conclusion: 'success' }),
      ],
    });
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    const state = await client.read('c'.repeat(40));
    expect(state?.id).toBe(2);
    expect(state?.conclusion).toBe('success');
  });

  it('surfaces provenance so an inherited green is distinguishable', async () => {
    const { octokit } = fakeOctokit({
      existing: [run({ external_id: encodeProvenance(provenance({ src: 'mirror', auth: 6 })) })],
    });
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    const state = await client.read('c'.repeat(40));
    expect(state?.provenance?.src).toBe('mirror');
    expect(state?.provenance?.auth).toBe(6);
  });
});

describe('ChecksClient.write', () => {
  it('creates a check when the SHA has none', async () => {
    const { octokit, calls } = fakeOctokit({});
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    const result = await client.write(entry());
    expect(result).toEqual({ id: 999, created: true });
    expect(calls.create).toHaveLength(1);
    expect(calls.update).toHaveLength(0);
    expect(calls.create[0]).toMatchObject({
      name: 'stack-optimization',
      head_sha: 'b'.repeat(40),
      status: 'completed',
      conclusion: 'success',
    });
  });

  it('updates in place so re-propagation leaves one check, not ten', async () => {
    const { octokit, calls } = fakeOctokit({ existing: [run({ id: 77 })] });
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    const result = await client.write(entry());
    expect(result).toEqual({ id: 77, created: false });
    expect(calls.create).toHaveLength(0);
    expect(calls.update[0]).toMatchObject({ check_run_id: 77 });
  });

  it('withholds with action_required when a completed check cannot be reopened', async () => {
    // GitHub accepts `status: in_progress` on a completed check run and ignores
    // it, so a hold expressed that way would silently leave a stale `success`
    // in place — the one outcome this project exists to prevent.
    const { octokit, calls } = fakeOctokit({ existing: [run({ id: 42, conclusion: 'success' })] });
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    await client.write(entry({ status: 'in_progress', conclusion: null, title: 'Waiting' }));
    expect(calls.update[0]).toMatchObject({
      check_run_id: 42,
      status: 'completed',
      conclusion: 'action_required',
      output: { title: 'Waiting' },
    });
  });

  it('still holds as in_progress when the existing check has not completed', async () => {
    const { octokit, calls } = fakeOctokit({
      existing: [run({ id: 42, status: 'in_progress', conclusion: null })],
    });
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    await client.write(entry({ status: 'in_progress', conclusion: null }));
    expect(calls.update[0]).toMatchObject({ status: 'in_progress' });
    expect(calls.update[0]).not.toHaveProperty('conclusion');
  });

  it('holds as in_progress when there is no existing check at all', async () => {
    const { octokit, calls } = fakeOctokit({});
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    await client.write(entry({ status: 'in_progress', conclusion: null }));
    expect(calls.create[0]).toMatchObject({ status: 'in_progress' });
    expect(calls.create[0]).not.toHaveProperty('conclusion');
  });

  it('keeps hold provenance, so a withheld check is never mirrored', async () => {
    const { octokit, calls } = fakeOctokit({ existing: [run({ id: 42, conclusion: 'success' })] });
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    await client.write(
      entry({
        status: 'in_progress',
        conclusion: null,
        provenance: provenance({ src: 'hold' }),
      }),
    );
    expect(decodeProvenance((calls.update[0] as { external_id: string }).external_id)?.src).toBe(
      'hold',
    );
  });

  it('omits conclusion when holding a check in progress', async () => {
    const { octokit, calls } = fakeOctokit({});
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    await client.write(entry({ status: 'in_progress', conclusion: null }));
    expect(calls.create[0]).toMatchObject({ status: 'in_progress' });
    expect(calls.create[0]).not.toHaveProperty('conclusion');
  });

  it('writes provenance into external_id', async () => {
    const { octokit, calls } = fakeOctokit({});
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    await client.write(entry());
    const external = (calls.create[0] as { external_id: string }).external_id;
    expect(decodeProvenance(external)?.src).toBe('mirror');
  });

  it('lets a standalone caller own the correlation id', async () => {
    const { octokit, calls } = fakeOctokit({});
    const client = new ChecksClient(octokit, REPO, 'stack-optimization', 'my-own-id');
    await client.write(entry());
    expect(calls.create[0]).toMatchObject({ external_id: 'my-own-id' });
  });

  it('omits external_id entirely when passed null', async () => {
    // `post-check` is a general primitive. Stamping a stack-specific provenance
    // marker onto an unrelated check would later be misread as a verdict of
    // unknown provenance.
    const { octokit, calls } = fakeOctokit({});
    const client = new ChecksClient(octokit, REPO, 'stack-optimization', null);
    await client.write(entry());
    expect(calls.create[0]).not.toHaveProperty('external_id');
  });

  it('leaves an existing external_id untouched when omitting it', async () => {
    const { octokit, calls } = fakeOctokit({ existing: [run({ id: 55, external_id: 'theirs' })] });
    const client = new ChecksClient(octokit, REPO, 'stack-optimization', null);
    await client.write(entry());
    expect(calls.update[0]).toMatchObject({ check_run_id: 55 });
    expect(calls.update[0]).not.toHaveProperty('external_id');
  });

  it('falls back to creating when the existing check belongs to another app', async () => {
    // A check run can only be PATCHed by the app that created it, so switching
    // the `token` input to a bot identity makes the update 403.
    const { octokit, calls } = fakeOctokit({
      existing: [run({ id: 77 })],
      onUpdate: () => {
        throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
      },
    });
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    const result = await client.write(entry());
    expect(result).toEqual({ id: 999, created: true });
    expect(calls.update).toHaveLength(1);
    expect(calls.create).toHaveLength(1);
  });

  it('does not swallow a genuine error', async () => {
    const { octokit } = fakeOctokit({
      existing: [run({ id: 77 })],
      onUpdate: () => {
        throw Object.assign(new Error('Validation failed'), { status: 422 });
      },
    });
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    await expect(client.write(entry())).rejects.toThrow('Validation failed');
  });

  it('includes extended text only when given', async () => {
    const { octokit, calls } = fakeOctokit({});
    const client = new ChecksClient(octokit, REPO, 'stack-optimization');
    await client.write(entry(), 'the details');
    expect(calls.create[0]).toMatchObject({
      output: { title: 'Mirrors #6', summary: 'Gated by #6.', text: 'the details' },
    });
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
    );
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('handles an empty list and a limit below one', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 0, async (n) => n)).toEqual([1, 2]);
  });
});

describe('withRetry', () => {
  it('returns the first success without waiting', async () => {
    expect(await withRetry('t', async () => 'ok')).toBe('ok');
  });

  it('retries a secondary rate limit', async () => {
    let calls = 0;
    const result = await withRetry(
      't',
      async () => {
        calls++;
        if (calls < 2) {
          throw Object.assign(new Error('You have exceeded a secondary rate limit'), {
            status: 403,
            response: { headers: { 'retry-after': '0' } },
          });
        }
        return 'ok';
      },
      3,
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does not retry a permission 403, which would never succeed', async () => {
    let calls = 0;
    await expect(
      withRetry('t', async () => {
        calls++;
        throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
      }),
    ).rejects.toThrow('not accessible');
    expect(calls).toBe(1);
  });

  it('gives up after the attempt budget', async () => {
    let calls = 0;
    await expect(
      withRetry(
        't',
        async () => {
          calls++;
          throw Object.assign(new Error('boom'), {
            status: 500,
            response: { headers: { 'retry-after': '0' } },
          });
        },
        3,
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(3);
  });

  it('does not retry a 404', async () => {
    let calls = 0;
    await expect(
      withRetry('t', async () => {
        calls++;
        throw Object.assign(new Error('nope'), { status: 404 });
      }),
    ).rejects.toThrow('nope');
    expect(calls).toBe(1);
  });
});
