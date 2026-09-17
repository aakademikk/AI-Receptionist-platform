// Read named variables out of a dotenv file and print them as KEY=value lines.
//
// Usage: read-env-vars.mjs <env-file> NAME [NAME...]
//
// Only the names asked for are printed, so a caller that needs two variables
// cannot accidentally spill the other twenty-three in the file. Nothing is
// logged, and there is no "print everything" mode on purpose.
//
// Why a Node parser rather than `source` or `grep`: sourcing a dotenv in bash
// breaks silently on a value containing a space, quote or '#', and this is the
// same parser already proven against the real file by
// ~/.local/bin/receptionist-app.mjs.

import { readFileSync } from 'node:fs';

const [envPath, ...wanted] = process.argv.slice(2);

if (!envPath || wanted.length === 0) {
  process.stderr.write('usage: read-env-vars.mjs <env-file> NAME [NAME...]\n');
  process.exit(64);
}

const want = new Set(wanted);

for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;

  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/);
  if (!match || !want.has(match[1])) continue;

  let value = match[2].trim();
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (quoted) value = value.slice(1, -1);

  // An empty value is the same as absent for our purposes, and letting it through
  // would defeat the caller's "is it set?" check.
  if (value !== '') process.stdout.write(`${match[1]}=${value}\n`);
}
