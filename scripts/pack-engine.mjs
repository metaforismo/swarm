#!/usr/bin/env node
/**
 * Rebuilds Reveal Engine from the sibling checkout and re-packs the tarball this
 * repository depends on.
 *
 * SWARM consumes the engine as a real package, never as vendored source: the
 * tarball in `vendor/` is exactly what `npm pack` produces from
 * `../reveal-engine`, so `npm ci` here is hermetic and CI needs no second
 * checkout. Run this after any engine change, then `npm install`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const engine = fileURLToPath(new URL('../../reveal-engine', import.meta.url));
const vendor = fileURLToPath(new URL('../vendor', import.meta.url));

if (!existsSync(engine)) {
  console.error(`No engine checkout at ${engine}. Clone reveal-engine beside this repository.`);
  process.exit(1);
}

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

run('npm', ['run', 'build'], engine);
run('npm', ['pack', '--pack-destination', vendor], engine);
console.log('\nPacked. Now run: npm install');
