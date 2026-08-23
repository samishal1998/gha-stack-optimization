/**
 * Configuration: action inputs layered over an optional repository config file.
 *
 * The file is always read from the repository's default branch, never from the
 * pull request under evaluation — a fork PR must not be able to reconfigure the
 * gate that judges it.
 */
import * as core from '@actions/core';
import * as yaml from 'js-yaml';
import { optionalBoolean, optionalList, optionalString } from './github.js';
import type { Octokit, Repo } from './github.js';
import { DEFAULT_CONFIG, type ResolvedConfig } from './types.js';

const DEFAULT_CONFIG_PATH = '.github/stack-optimization.yml';

interface FileConfig {
  'check-name'?: unknown;
  'checkpoint-label'?: unknown;
  'force-run-label'?: unknown;
  'always-run-paths'?: unknown;
  'propagate-failures'?: unknown;
  'skip-draft-head'?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((v): v is string => typeof v === 'string');
  return list.length > 0 ? list : undefined;
}

/** Fetch and parse the repo config file. Absent or unreadable is not an error. */
export async function readConfigFile(
  octokit: Octokit,
  repo: Repo,
  path = DEFAULT_CONFIG_PATH,
): Promise<FileConfig> {
  try {
    const { data } = await octokit.rest.repos.getContent({ ...repo, path });
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return {};
    const text = Buffer.from(data.content, 'base64').toString('utf8');
    const parsed: unknown = yaml.load(text);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as FileConfig;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return {};
    core.warning(`Could not read ${path}: ${String(err)}. Falling back to defaults.`);
    return {};
  }
}

/**
 * Merge, most specific first: action inputs win over the config file, which
 * wins over the built-in defaults.
 */
export function mergeConfig(file: FileConfig): ResolvedConfig {
  return {
    checkName:
      optionalString('check-name') ?? asString(file['check-name']) ?? DEFAULT_CONFIG.checkName,
    checkpointLabel:
      optionalString('checkpoint-label') ??
      asString(file['checkpoint-label']) ??
      DEFAULT_CONFIG.checkpointLabel,
    forceRunLabel:
      optionalString('force-run-label') ??
      asString(file['force-run-label']) ??
      DEFAULT_CONFIG.forceRunLabel,
    alwaysRunPaths:
      optionalList('always-run-paths') ??
      asStringList(file['always-run-paths']) ??
      DEFAULT_CONFIG.alwaysRunPaths,
    propagateFailures:
      optionalBoolean('propagate-failures') ??
      asBoolean(file['propagate-failures']) ??
      DEFAULT_CONFIG.propagateFailures,
    skipDraftHead:
      optionalBoolean('skip-draft-head') ??
      asBoolean(file['skip-draft-head']) ??
      DEFAULT_CONFIG.skipDraftHead,
  };
}

/** Resolve configuration for an action run. */
export async function resolveConfig(octokit: Octokit, repo: Repo): Promise<ResolvedConfig> {
  const path = optionalString('config-path') ?? DEFAULT_CONFIG_PATH;
  const file = await readConfigFile(octokit, repo, path);
  return mergeConfig(file);
}
