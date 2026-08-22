/** `stack-gate/propagate` — execute a verdict plan. */
import * as core from '@actions/core';
import { ChecksClient, mapWithConcurrency, withRetry } from '../checks.js';
import { fail, getRepo, makeOctokit, optionalBoolean, optionalString } from '../github.js';
import { DEFAULT_CONFIG } from '../types.js';
import type { Octokit, Repo } from '../github.js';
import type { PlanEntry } from '../types.js';

interface Result {
  pr: number;
  sha: string;
  status: 'posted' | 'skipped-stale' | 'dry-run';
  check_run_id?: number;
  created?: boolean;
  current_sha?: string;
}

function parsePlan(raw: string): PlanEntry[] {
  if (!raw.trim()) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('The `plan` input must be a JSON array.');
  for (const entry of parsed) {
    const e = entry as Partial<PlanEntry>;
    if (typeof e.sha !== 'string' || !e.sha) throw new Error('A plan entry is missing `sha`.');
    if (e.status === 'completed' && !e.conclusion) {
      throw new Error(`Plan entry for #${e.pr} is completed but has no conclusion.`);
    }
  }
  return parsed as PlanEntry[];
}

/**
 * The PR's head SHA right now. Writing a stale verdict onto a *new* SHA is a
 * correctness bug, so anything that moved while the gate was running is skipped
 * and left to its own seed/gate cycle.
 */
async function currentHeadSha(
  octokit: Octokit,
  repo: Repo,
  prNumber: number,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.pulls.get({ ...repo, pull_number: prNumber });
    return data.head.sha;
  } catch (err) {
    core.warning(`Could not confirm the head SHA of #${prNumber}: ${String(err)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const plan = parsePlan(core.getInput('plan'));
  const checkName = optionalString('check-name') ?? DEFAULT_CONFIG.checkName;
  const dryRun = optionalBoolean('dry-run') ?? false;
  const maxConcurrency = Number(optionalString('max-concurrency') ?? '4');
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('`max-concurrency` must be a positive integer.');
  }

  const octokit = makeOctokit();
  const repo = getRepo();
  const client = new ChecksClient(octokit, repo, checkName);

  const results = await mapWithConcurrency(plan, maxConcurrency, async (entry): Promise<Result> => {
    // pr 0 means "no PR to verify against" — post-check's standalone shape.
    if (entry.pr > 0) {
      const current = await currentHeadSha(octokit, repo, entry.pr);
      if (current !== null && current !== entry.sha) {
        core.info(
          `Skipping #${entry.pr}: head moved ${entry.sha.slice(0, 7)} -> ${current.slice(0, 7)} ` +
            'while the gate was running. Its own gate cycle will report it.',
        );
        return { pr: entry.pr, sha: entry.sha, status: 'skipped-stale', current_sha: current };
      }
    }

    if (dryRun) {
      core.info(
        `[dry-run] #${entry.pr} ${entry.sha.slice(0, 7)} -> ${entry.status}` +
          `${entry.conclusion ? `/${entry.conclusion}` : ''} (${entry.reason})`,
      );
      return { pr: entry.pr, sha: entry.sha, status: 'dry-run' };
    }

    const written = await withRetry(`propagate #${entry.pr}`, () => client.write(entry));
    core.info(
      `#${entry.pr} ${entry.sha.slice(0, 7)} -> ${entry.status}` +
        `${entry.conclusion ? `/${entry.conclusion}` : ''} (${entry.reason})`,
    );
    return {
      pr: entry.pr,
      sha: entry.sha,
      status: 'posted',
      check_run_id: written.id,
      created: written.created,
    };
  });

  const posted = results.filter((r) => r.status === 'posted' || r.status === 'dry-run').length;
  const stale = results.filter((r) => r.status === 'skipped-stale').length;

  core.setOutput('posted', String(posted));
  core.setOutput('skipped-stale', String(stale));
  core.setOutput('results', JSON.stringify(results));
  core.info(`Posted ${posted} check${posted === 1 ? '' : 's'}; skipped ${stale} stale.`);
}

try {
  await main();
} catch (err) {
  fail(err);
}
