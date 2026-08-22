import { afterEach, describe, expect, it } from 'vitest';
import { mergeConfig } from '../src/config.js';
import { DEFAULT_CONFIG } from '../src/types.js';

/**
 * Input precedence is load-bearing, not cosmetic. The reusable workflow used to
 * forward its own defaults, so an action input was never empty and always beat
 * the repository config file. A repo configured with `check-name: ci-gate` got
 * checks named `stack-gate` while branch protection waited for `ci-gate`, and
 * every pull request was blocked forever. These tests pin the ordering.
 */

const TOUCHED: string[] = [];

function setInput(name: string, value: string): void {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  process.env[key] = value;
  TOUCHED.push(key);
}

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
  TOUCHED.length = 0;
});

describe('mergeConfig precedence', () => {
  it('falls back to the built-in defaults with no input and no file', () => {
    expect(mergeConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it('takes the config file over the defaults', () => {
    const c = mergeConfig({
      'check-name': 'ci-gate',
      'checkpoint-label': 'cut-here',
      'force-run-label': 'force-ci',
      'always-run-paths': ['migrations/**'],
      'propagate-failures': false,
      'skip-draft-head': false,
    });
    expect(c).toEqual({
      checkName: 'ci-gate',
      checkpointLabel: 'cut-here',
      forceRunLabel: 'force-ci',
      alwaysRunPaths: ['migrations/**'],
      propagateFailures: false,
      skipDraftHead: false,
    });
  });

  it('takes an explicit input over the config file', () => {
    setInput('check-name', 'from-input');
    expect(mergeConfig({ 'check-name': 'from-file' }).checkName).toBe('from-input');
  });

  it('treats an empty input as absent, so the config file still wins', () => {
    // This is the exact case the reusable workflow depends on: it forwards
    // `${{ inputs.check-name }}`, which is an empty string when the caller did
    // not set it. If empty counted as a value, the file would be unreachable.
    for (const name of ['check-name', 'checkpoint-label', 'force-run-label']) {
      setInput(name, '');
    }
    const c = mergeConfig({
      'check-name': 'ci-gate',
      'checkpoint-label': 'cut-here',
      'force-run-label': 'force-ci',
    });
    expect(c.checkName).toBe('ci-gate');
    expect(c.checkpointLabel).toBe('cut-here');
    expect(c.forceRunLabel).toBe('force-ci');
  });

  it('treats an empty boolean input as absent rather than false', () => {
    setInput('propagate-failures', '');
    setInput('skip-draft-head', '');
    const c = mergeConfig({ 'propagate-failures': false, 'skip-draft-head': false });
    expect(c.propagateFailures).toBe(false);
    expect(c.skipDraftHead).toBe(false);

    const d = mergeConfig({});
    expect(d.propagateFailures).toBe(true);
    expect(d.skipDraftHead).toBe(true);
  });

  it('reads boolean inputs when they are actually set', () => {
    setInput('propagate-failures', 'false');
    expect(mergeConfig({ 'propagate-failures': true }).propagateFailures).toBe(false);
  });

  it('accepts always-run-paths as a newline or comma separated input', () => {
    setInput('always-run-paths', 'migrations/**\n**/*.sql');
    expect(mergeConfig({}).alwaysRunPaths).toEqual(['migrations/**', '**/*.sql']);

    setInput('always-run-paths', 'a/**, b/**');
    expect(mergeConfig({}).alwaysRunPaths).toEqual(['a/**', 'b/**']);
  });

  it('ignores config-file values of the wrong type instead of trusting them', () => {
    const c = mergeConfig({
      'check-name': 42,
      'always-run-paths': 'not-a-list',
      'propagate-failures': 'yes',
      'skip-draft-head': null,
    });
    expect(c).toEqual(DEFAULT_CONFIG);
  });

  it('ignores a blank config-file string', () => {
    expect(mergeConfig({ 'check-name': '   ' }).checkName).toBe(DEFAULT_CONFIG.checkName);
  });

  it('drops non-string entries from always-run-paths', () => {
    expect(mergeConfig({ 'always-run-paths': ['ok/**', 7, null] }).alwaysRunPaths).toEqual([
      'ok/**',
    ]);
  });
});
