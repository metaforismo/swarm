#!/usr/bin/env node
/**
 * Writes the machine-generated tables into the documentation.
 *
 * Every table in the docs that is derived from the model lives between
 * `<!-- generated:<name> -->` and `<!-- /generated:<name> -->` markers. This
 * script fills those blocks from `renderBlocks()`; `tests/` then re-checks them
 * byte for byte, so a hand edit inside a block fails the build rather than
 * quietly publishing a wrong number.
 *
 * Usage:
 *   node tools/syncdocs.mjs            rewrite the documents in place
 *   node tools/syncdocs.mjs --check    fail if any block is stale
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderBlocks } from './lib/doctables.mjs';

export const DOCUMENTS = ['README.md', 'docs/MATH.md', 'docs/DESIGN.md', 'docs/ENGINE.md'];

const MARKER = /<!-- generated:([a-z][a-z0-9-]*) -->\n([\s\S]*?)\n<!-- \/generated:\1 -->/gu;

/** Returns the document text with every generated block replaced, plus what changed. */
export function applyBlocks(text, blocks, document = '<memory>') {
  const seen = [];
  const updated = text.replace(MARKER, (match, name, body) => {
    const replacement = blocks[name];
    if (replacement === undefined)
      throw new Error(`${document} references an unknown generated block: ${name}`);
    seen.push({ name, stale: body !== replacement });
    return `<!-- generated:${name} -->\n${replacement}\n<!-- /generated:${name} -->`;
  });
  return { updated, seen };
}

function main(argv) {
  const check = argv.includes('--check');
  const unknown = argv.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`usage: node tools/syncdocs.mjs [--check]`);
    return 2;
  }

  const root = fileURLToPath(new URL('..', import.meta.url));
  const blocks = renderBlocks();
  const published = new Set();
  let stale = 0;

  for (const document of DOCUMENTS) {
    const path = `${root}${document}`;
    const text = readFileSync(path, 'utf8');
    const { updated, seen } = applyBlocks(text, blocks, document);
    for (const entry of seen) {
      published.add(entry.name);
      if (entry.stale) {
        stale += 1;
        console.log(`${check ? 'STALE' : 'updated'}  ${document}  ${entry.name}`);
      }
    }
    if (!check && updated !== text) writeFileSync(path, updated, 'utf8');
  }

  const orphans = Object.keys(blocks).filter((name) => !published.has(name));
  if (orphans.length > 0) {
    console.error(`Generated blocks that no document publishes: ${orphans.join(', ')}`);
    return 1;
  }

  if (check && stale > 0) {
    console.error(`\n${stale} generated block(s) are stale. Run: npm run docs:sync`);
    return 1;
  }
  console.log(
    check
      ? `all ${published.size} generated blocks are current`
      : `${stale === 0 ? 'no changes' : `${stale} block(s) rewritten`} across ${DOCUMENTS.length} documents`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
