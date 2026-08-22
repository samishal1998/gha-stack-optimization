/**
 * Bundle each action entrypoint into its own committed dist/.
 *
 * GitHub Actions runs `dist/index.js` straight from the repository, so the
 * bundles are checked in and CI verifies they match the source.
 */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const ACTIONS = ['context', 'should-run', 'post-check', 'verdict', 'propagate', 'seed'];

// The bundle is ESM (@actions/core and @actions/github are ESM-only), but some
// transitive dependencies are CommonJS and call require() at runtime.
const BANNER =
  "import { createRequire as __stackGateCreateRequire } from 'node:module';\n" +
  'const require = __stackGateCreateRequire(import.meta.url);\n';

const results = [];

for (const action of ACTIONS) {
  const outdir = join(root, 'actions', action, 'dist');
  await mkdir(outdir, { recursive: true });

  const result = await build({
    entryPoints: [join(root, 'src', 'entrypoints', `${action}.ts`)],
    outfile: join(outdir, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    banner: { js: BANNER },
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
  });

  // dist/index.js is ESM, but the repository root declares no module type for
  // consumers checking out the action, so pin it here.
  await writeFile(join(outdir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

  const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
  results.push({ action, kb: Math.round(bytes / 1024) });
}

for (const { action, kb } of results) {
  console.log(`  ${action.padEnd(12)} ${String(kb).padStart(5)} kB`);
}
console.log(`\nBuilt ${results.length} action bundles.`);
