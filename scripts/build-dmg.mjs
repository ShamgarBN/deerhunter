#!/usr/bin/env node
// Build the macOS app and leave the .dmg where it can be found.
//
// This script exists mostly to own one awkward fact: better-sqlite3 is a native module and
// Node and Electron have different ABIs (137 and 150 at the time of writing). A binary
// built for one will not load in the other. Packaging therefore has to rebuild it for
// Electron, which would otherwise leave the checkout unable to run `npm run backup` or any
// other CLI command afterwards.
//
// So the rebuild is bracketed: build for Electron, package, then rebuild for Node. The
// churn lives here instead of in anyone's head.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });

const step = (msg) => console.log(`\n\u001b[1m==> ${msg}\u001b[0m`);

// Recorded so a fresh install can offer to import from the checkout it came from, which
// is the difference between the packaged app having his sit log and starting empty.
step('Recording the source checkout');
fs.writeFileSync(
  path.join(ROOT, 'electron', 'build-info.json'),
  JSON.stringify({ sourceDir: ROOT, builtAt: new Date().toISOString() }, null, 2) + '\n',
);
console.log(`    ${ROOT}`);

step('Rebuilding better-sqlite3 for the Electron ABI');
run('npx', ['--no-install', 'electron-builder', 'install-app-deps']);

let built = false;
try {
  step('Packaging');
  run('npx', ['--no-install', 'electron-builder', '--mac', 'dmg']);
  built = true;
} finally {
  // Always, even if packaging failed: leaving the checkout on the Electron ABI would
  // break every CLI command with an error that says nothing about why.
  step('Rebuilding better-sqlite3 back to the Node ABI');
  try {
    run('npm', ['rebuild', 'better-sqlite3', '--build-from-source=false']);
  } catch {
    console.error('    Could not restore the Node build. Run: npm rebuild better-sqlite3');
  }
}

if (!built) process.exit(1);

step('Copying the disk image to the project root');
const dist = path.join(ROOT, 'dist');
const dmgs = fs.readdirSync(dist).filter((f) => f.endsWith('.dmg'));
if (!dmgs.length) {
  console.error('    No .dmg in dist/. Packaging reported success but produced nothing.');
  process.exit(1);
}
for (const name of dmgs) {
  const to = path.join(ROOT, name);
  fs.copyFileSync(path.join(dist, name), to);
  const mb = (fs.statSync(to).size / 1048576).toFixed(1);
  console.log(`    ${name}  (${mb} MB)`);
}

console.log(`
Done. The app is unsigned, so the first launch needs Finder: right-click the
app and choose Open, then confirm. Double-clicking it will be refused by
Gatekeeper without an obvious way forward.

Verify the CLI still works:  npm test
`);
