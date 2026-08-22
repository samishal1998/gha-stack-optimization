/**
 * Octokit plumbing and event-payload helpers.
 *
 * The gate runs in the base-repo context with a write-capable token and is
 * reachable from fork PRs, so nothing here checks out or executes PR code — it
 * reads metadata only.
 */
import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';

export type Octokit = ReturnType<typeof getOctokit>;

export interface Repo {
  owner: string;
  repo: string;
}

export function getRepo(): Repo {
  return { owner: context.repo.owner, repo: context.repo.repo };
}

export function getToken(): string {
  const token = core.getInput('token') || process.env['GITHUB_TOKEN'] || '';
  if (!token) {
    throw new Error(
      'No token available. Pass the `token` input or set GITHUB_TOKEN in the environment.',
    );
  }
  return token;
}

export function makeOctokit(token = getToken()): Octokit {
  return getOctokit(token);
}

/** Read a boolean input that may legitimately be absent. */
export function optionalBoolean(name: string): boolean | undefined {
  const raw = core.getInput(name);
  if (!raw) return undefined;
  return core.getBooleanInput(name);
}

/** Read a string input, returning undefined rather than an empty string. */
export function optionalString(name: string): string | undefined {
  const raw = core.getInput(name);
  return raw === '' ? undefined : raw;
}

/** Read a newline- or comma-separated list input. */
export function optionalList(name: string): string[] | undefined {
  const raw = core.getInput(name);
  if (!raw.trim()) return undefined;
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface WorkflowRunPayload {
  id: number;
  html_url: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string | null;
  event: string;
  pull_requests?: Array<{ number: number }> | null;
}

export function workflowRunPayload(): WorkflowRunPayload | null {
  const run = (context.payload as { workflow_run?: WorkflowRunPayload }).workflow_run;
  return run ?? null;
}

/**
 * Resolve which PR a completed workflow run belongs to.
 *
 * Three tiers, because the cheap answer is missing exactly where PRD 11 says
 * the system must still work:
 *
 *   1. `workflow_run.pull_requests` — present for same-repo PRs, and empty for
 *      fork PRs.
 *   2. The commit's associated PRs.
 *   3. A scan of open PRs matching the run's head SHA. This is the one that
 *      catches fork PRs, whose head lives in another repository.
 */
export async function resolvePrForSha(
  octokit: Octokit,
  repo: Repo,
  headSha: string,
  fromPayload: ReadonlyArray<{ number: number }> | null | undefined,
): Promise<number | null> {
  if (fromPayload && fromPayload.length > 0) {
    const first = fromPayload[0]!;
    core.debug(`Resolved PR #${first.number} from the workflow_run payload.`);
    return first.number;
  }

  try {
    const { data } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      ...repo,
      commit_sha: headSha,
      per_page: 100,
    });
    const open = data.find((pr) => pr.state === 'open') ?? data[0];
    if (open) {
      core.debug(`Resolved PR #${open.number} from the commit's associated pull requests.`);
      return open.number;
    }
  } catch (err) {
    core.debug(`Associated-PR lookup failed for ${headSha}: ${String(err)}`);
  }

  // Fork PRs land here: their head SHA is not associated with a base-repo
  // commit, but the PR itself is still listed against the base repo.
  const open = await octokit.paginate(octokit.rest.pulls.list, {
    ...repo,
    state: 'open',
    per_page: 100,
  });
  const match = open.find((pr) => pr.head.sha === headSha);
  if (match) {
    core.debug(`Resolved PR #${match.number} by scanning open pull requests.`);
    return match.number;
  }

  return null;
}

/** The PR number this action is acting on, from the input or the event payload. */
export function prNumberFromEvent(): number | null {
  const explicit = core.getInput('pr-number');
  if (explicit) {
    const parsed = Number(explicit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid pr-number input: ${explicit}`);
    }
    return parsed;
  }
  const payload = context.payload as {
    pull_request?: { number: number };
    issue?: { number: number; pull_request?: unknown };
  };
  if (payload.pull_request) return payload.pull_request.number;
  if (payload.issue?.pull_request) return payload.issue.number;
  return null;
}

/**
 * The PR this action is acting on, for any event the suite runs on.
 *
 * `pull_request` events carry it directly; a `workflow_run` completion has to
 * be traced back from the run's head SHA.
 */
export async function resolveTargetPr(octokit: Octokit, repo: Repo): Promise<number | null> {
  const direct = prNumberFromEvent();
  if (direct !== null) return direct;

  const run = workflowRunPayload();
  if (run) {
    const resolved = await resolvePrForSha(octokit, repo, run.head_sha, run.pull_requests);
    if (resolved === null) {
      core.warning(
        `No open pull request matches ${run.head_sha.slice(0, 7)} (workflow run ${run.id}). ` +
          'Nothing to gate — this is expected for pushes to a branch with no PR.',
      );
    }
    return resolved;
  }
  return null;
}

/**
 * Neutralise text that came from a pull request before it reaches check-run
 * markdown. Titles, branch names and label text are attacker-controlled on a
 * fork PR, and the gate writes them into a surface that repository members
 * read.
 */
export function sanitize(text: string, max = 200): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[`<>[\]()|*_#!\\]/g, '')
    .trim()
    .slice(0, max);
}

/** Fail the step with a message, without leaking a stack trace into the log. */
export function fail(err: unknown): void {
  core.setFailed(err instanceof Error ? err.message : String(err));
}
