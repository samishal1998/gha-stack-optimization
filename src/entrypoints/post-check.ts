/** `stack-optimization/post-check` — the low-level idempotent check-run primitive. */
import * as core from '@actions/core';
import { ChecksClient, withRetry } from '../checks.js';
import { fail, getRepo, makeOctokit, optionalString } from '../github.js';
import { DEFAULT_CONFIG } from '../types.js';
import type { CheckStatus, GateConclusion, PlanEntry } from '../types.js';

const STATUSES: CheckStatus[] = ['queued', 'in_progress', 'completed'];
const CONCLUSIONS: GateConclusion[] = ['success', 'failure', 'neutral'];

async function main(): Promise<void> {
  const sha = core.getInput('sha', { required: true });
  const name = optionalString('name') ?? DEFAULT_CONFIG.checkName;
  const status = (optionalString('status') ?? 'completed') as CheckStatus;
  const conclusionInput = optionalString('conclusion');

  if (!STATUSES.includes(status)) {
    throw new Error(`Invalid status "${status}". Expected one of ${STATUSES.join(', ')}.`);
  }
  if (status === 'completed' && !conclusionInput) {
    throw new Error('`conclusion` is required when `status` is `completed`.');
  }
  if (conclusionInput && !CONCLUSIONS.includes(conclusionInput as GateConclusion)) {
    throw new Error(
      `Invalid conclusion "${conclusionInput}". Expected one of ${CONCLUSIONS.join(', ')}.`,
    );
  }

  const entry: PlanEntry = {
    pr: 0,
    sha,
    status,
    conclusion: status === 'completed' ? (conclusionInput as GateConclusion) : null,
    reason: 'not-in-stack-own-ci',
    title: optionalString('title') ?? name,
    summary: optionalString('summary') ?? '',
    details_url: optionalString('details-url') ?? null,
    provenance: { v: 1, src: 'hold', auth: null, authSha: null, forced: false },
  };

  // This primitive knows nothing about stacks, so it never writes the gate's
  // provenance marker. The caller's own correlation id is used if given, and
  // otherwise `external_id` is left alone entirely.
  const externalId = optionalString('external-id') ?? null;
  const client = new ChecksClient(makeOctokit(), getRepo(), name, externalId);
  const result = await withRetry(`post-check ${name}@${sha.slice(0, 7)}`, () =>
    client.write(entry, optionalString('text')),
  );

  core.setOutput('check-run-id', String(result.id));
  core.setOutput('created', String(result.created));
  core.info(`${result.created ? 'Created' : 'Updated'} check "${name}" on ${sha.slice(0, 7)}.`);
}

try {
  await main();
} catch (err) {
  fail(err);
}
