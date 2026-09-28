#!/usr/bin/env node
// Runs `tsx --test` over every *.test.ts file in the given folder. Node 20 on Windows does not
// expand `tests/*.test.ts` (npm scripts run without a glob-expanding shell there).
//   node scripts/run-tests.mjs <folder> [extra node --test flags]
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const [folder = 'tests', ...flags] = process.argv.slice(2);
const files = readdirSync(folder)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => join(folder, name));
if (!files.length) {
  console.error(`No *.test.ts files in ${folder}`);
  process.exit(1);
}
// The tsx CLI through node itself: no shell, no .cmd shims on Windows.
const require = createRequire(import.meta.url);
const tsx = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const result = spawnSync(process.execPath, [tsx, '--test', ...flags, ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
