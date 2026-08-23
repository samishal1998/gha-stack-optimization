/**
 * Checks API client: idempotent check-run upsert keyed on (name, sha).
 *
 * A stack that re-propagates ten times must not leave ten check runs on a
 * parent, so every write lists the SHA's existing runs under our name and
 * PATCHes the most recent match instead of creating a new one.
 */
import * as core from '@actions/core';
import type { GateCheckState, PlanEntry, Provenance } from './types.js';
import type { Octokit, Repo } from './github.js';

/** Marker prefix so a check run written by something else is never mistaken for ours. */
const PROVENANCE_PREFIX = 'stack-optimization:';

export function encodeProvenance(p: Provenance): string {
  return PROVENANCE_PREFIX + JSON.stringify(p);
}

/**
 * Decode the provenance recorded in a check run's `external_id`. Anything we
 * did not write, or cannot parse, reads as unknown — and unknown provenance is
 * never treated as an established verdict.
 */
export function decodeProvenance(externalId: string | null | undefined): Provenance | null {
  if (!externalId || !externalId.startsWith(PROVENANCE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(externalId.slice(PROVENANCE_PREFIX.length));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Partial<Provenance>;
    if (p.v !== 1) return null;
    if (p.src !== 'own-ci' && p.src !== 'mirror' && p.src !== 'hold') return null;
    return {
      v: 1,
      src: p.src,
      auth: typeof p.auth === 'number' ? p.auth : null,
      authSha: typeof p.authSha === 'string' ? p.authSha : null,
      forced: p.forced === true,
    };
  } catch {
    return null;
  }
}

export class ChecksClient {
  constructor(
    private readonly octokit: Octokit,
    private readonly repo: Repo,
    private readonly checkName: string,
    /**
     * What to write into `external_id`:
     *
     *   undefined  the gate's provenance marker, derived from the plan entry
     *   a string   the caller's own correlation id
     *   null       nothing at all, leaving any existing value untouched
     *
     * `post-check` passes a string or null, because it is a general-purpose
     * primitive: stamping a stack-specific marker onto an unrelated check would
     * be wrong, and would later be misread as a verdict of unknown provenance.
     */
    private readonly externalId?: string | null,
  ) {}

  /** The gate check currently on `sha`, or null if there isn't one. */
  async read(sha: string): Promise<GateCheckState | null> {
    const { data } = await this.octokit.rest.checks.listForRef({
      ...this.repo,
      ref: sha,
      check_name: this.checkName,
      filter: 'latest',
      per_page: 100,
    });
    const runs = data.check_runs;
    if (runs.length === 0) return null;
    // Most recently started wins; `filter: latest` already narrows per app.
    const latest = runs.reduce((a, b) => ((a.started_at ?? '') >= (b.started_at ?? '') ? a : b));
    return {
      id: latest.id,
      status: latest.status as GateCheckState['status'],
      conclusion: (latest.conclusion ?? null) as GateCheckState['conclusion'],
      detailsUrl: latest.details_url ?? null,
      provenance: decodeProvenance(latest.external_id),
    };
  }

  /**
   * Create or update the gate check on `entry.sha`.
   *
   * A check run can only be PATCHed by the app that created it. If the consumer
   * has switched `token` to a different identity (a bot or App token), the
   * PATCH is refused and we create a fresh run under our own identity instead.
   */
  async write(entry: PlanEntry, text?: string): Promise<{ id: number; created: boolean }> {
    const existing = await this.read(entry.sha);
    const externalId =
      this.externalId === undefined ? encodeProvenance(entry.provenance) : this.externalId;
    const body = {
      ...this.repo,
      name: this.checkName,
      status: entry.status,
      // Omitted rather than nulled: a PATCH leaves an unspecified field alone,
      // so a standalone caller's correlation id survives an update.
      ...(externalId === null ? {} : { external_id: externalId }),
      output: {
        title: entry.title,
        summary: entry.summary,
        ...(text ? { text } : {}),
      },
      ...(entry.conclusion ? { conclusion: entry.conclusion } : {}),
      ...(entry.details_url ? { details_url: entry.details_url } : {}),
    };

    if (existing) {
      try {
        const { data } = await this.octokit.rest.checks.update({
          ...body,
          check_run_id: existing.id,
        });
        return { id: data.id, created: false };
      } catch (err) {
        if (!isForbidden(err)) throw err;
        core.warning(
          `Cannot update check run ${existing.id} on ${entry.sha.slice(0, 7)} — it belongs to a ` +
            'different app identity. Creating a new one. If you changed the `token` input, expect ' +
            'one stale duplicate check until the next push.',
        );
      }
    }

    const { data } = await this.octokit.rest.checks.create({ ...body, head_sha: entry.sha });
    return { id: data.id, created: true };
  }
}

function isForbidden(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 403;
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving order.
 * Bounded concurrency keeps a deep stack from tripping secondary rate limits.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]!, i);
      }
    }),
  );
  return results;
}

/** Retry on secondary rate limits and transient 5xx, with exponential backoff. */
export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      const header = (err as { response?: { headers?: Record<string, string> } }).response
        ?.headers?.['retry-after'];
      // A bare 403 is a permission or app-identity problem and will never
      // succeed on retry; only a rate-limited 403 is worth waiting out.
      const rateLimited =
        status === 403 &&
        (header !== undefined || /rate limit/i.test(String((err as Error).message)));
      const retryable = rateLimited || status === 429 || (status !== undefined && status >= 500);
      if (!retryable || attempt >= attempts) throw err;
      // GitHub's Retry-After is authoritative when present, including zero.
      const wait = header !== undefined ? Number(header) * 1000 : delay;
      core.info(`${label}: ${status} — retrying in ${wait}ms (attempt ${attempt}/${attempts - 1})`);
      await sleep(wait);
      delay *= 2;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
