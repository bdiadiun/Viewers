#!/usr/bin/env node
// The contract in src/contract/messages.ts is a byte-identical copy of the host repository's
// packages/contract/src/messages.ts; this fork cannot import across the submodule boundary, so the
// committed sha256 next to the copy is what lets this repository detect drift on its own.
//
// Node built-ins only: it must run in a fresh clone with no dependencies installed.
//
// Usage: node extensions/scoring-bridge/scripts/check-contract-hash.mjs
// Exit code: 0 when the copy matches the committed hash, 1 otherwise.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const contractDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'contract');
const copyPath = join(contractDir, 'messages.ts');
const hashPath = join(contractDir, 'messages.sha256');

const main = () => {
  for (const path of [copyPath, hashPath]) {
    if (!existsSync(path)) {
      console.error(`FAIL: ${path} not found`);
      process.exit(1);
    }
  }

  const actual = createHash('sha256').update(readFileSync(copyPath)).digest('hex');
  const expected = readFileSync(hashPath, 'utf8').trim();

  if (actual === expected) {
    console.log('ok: src/contract/messages.ts matches the committed hash');
    process.exit(0);
  }

  console.error(`FAIL: src/contract/messages.ts hashes to ${actual}, expected ${expected}`);
  console.error('hint: the contract is owned by the host repository; sync it there, not here.');
  process.exit(1);
};

main();
