#!/usr/bin/env node
// Test runner without a TypeScript loader in the install path.
//
//   node scripts/run-tests.mjs tests                 unit tests: compiled with tsc to .build-tests/,
//                                                    then run with node --test (Node 20+, Windows too)
//   node scripts/run-tests.mjs contract [flags]      contract tests against a local app build; they
//                                                    import the app's TypeScript, so they need tsx:
//                                                    from this repo (npm install --no-save tsx) or
//                                                    from the app checkout in CC_APP_DIR
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const [folder = 'tests', ...flags] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const run = (args) => spawnSync(process.execPath, args, { stdio: 'inherit' }).status ?? 1;
const list = (dir, suffix) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => join(dir, name));

if (folder === 'tests') {
  rmSync('.build-tests', { recursive: true, force: true });
  const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  const built = run([tsc, '-p', 'tsconfig.test.json']);
  if (built !== 0) process.exit(built);
  process.exit(run(['--enable-source-maps', '--test', ...flags, ...list(join('.build-tests', 'tests'), '.test.js')]));
}

function findTsx() {
  const places = [import.meta.url];
  if (process.env.CC_APP_DIR) places.push(join(process.env.CC_APP_DIR, 'package.json'));
  for (const place of places) {
    try {
      return join(dirname(createRequire(place).resolve('tsx/package.json')), 'dist', 'cli.mjs');
    } catch {
      // try the next place
    }
  }
  return null;
}
const tsx = findTsx();
if (!tsx || !existsSync(tsx)) {
  console.error('The contract tests need tsx: run "npm install --no-save tsx" here, or set CC_APP_DIR to an app checkout with its dependencies installed.');
  process.exit(2);
}
process.exit(run([tsx, '--test', ...flags, ...list(folder, '.test.ts')]));
