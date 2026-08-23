/**
 * Run a built action bundle against a mock GitHub, the way the Actions runner
 * would: inputs as INPUT_* environment variables, outputs collected from
 * GITHUB_OUTPUT, the event payload from a file on disk.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** GITHUB_OUTPUT uses heredoc delimiters; parse them back into an object. */
function parseOutputs(text) {
  const out = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+)<<(\S+)$/.exec(lines[i]);
    if (!m) continue;
    const [, key, delim] = m;
    const buf = [];
    for (i++; i < lines.length && lines[i] !== delim; i++) buf.push(lines[i]);
    out[key] = buf.join('\n');
  }
  return out;
}

/**
 * @param {string} action  directory name under actions/
 * @param {object} opts
 * @param {string} opts.apiUrl     mock server base URL
 * @param {object} [opts.inputs]   action inputs, hyphenated names
 * @param {object} [opts.event]    event payload written to GITHUB_EVENT_PATH
 * @param {string} [opts.eventName]
 */
export async function runAction(action, { apiUrl, inputs = {}, event = {}, eventName = 'push' }) {
  const dir = mkdtempSync(join(tmpdir(), 'sg-'));
  const outputPath = join(dir, 'output.txt');
  const eventPath = join(dir, 'event.json');
  writeFileSync(outputPath, '');
  writeFileSync(eventPath, JSON.stringify(event));

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_API_URL: apiUrl,
    GITHUB_OUTPUT: outputPath,
    GITHUB_ENV: join(dir, 'env.txt'),
    GITHUB_STATE: join(dir, 'state.txt'),
    GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
    GITHUB_REPOSITORY: 'samishal1998/gha-stack-optimization',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_TOKEN: 'mock-token',
    RUNNER_DEBUG: '',
  };
  for (const [k, v] of Object.entries(inputs)) {
    if (v === undefined) continue;
    env[`INPUT_${k.replace(/ /g, '_').toUpperCase()}`] = String(v);
  }

  const child = spawn('node', [join(ROOT, 'actions', action, 'dist', 'index.js')], {
    env,
    cwd: dir,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => child.on('close', r));

  const outputs = parseOutputs(readFileSync(outputPath, 'utf8'));
  rmSync(dir, { recursive: true, force: true });

  // ::error:: lines are how @actions/core reports setFailed.
  const errors = stdout
    .split('\n')
    .filter((l) => l.startsWith('::error::'))
    .map((l) => l.slice('::error::'.length));

  return { code, stdout, stderr, outputs, errors, failed: code !== 0 || errors.length > 0 };
}
