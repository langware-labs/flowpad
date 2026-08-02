/**
 * PARKED — a KNOWN red, deliberately not fixed here.
 *
 * `flow_sdk/server/routes/artifacts.py::list_files` emits six keys per file;
 * the TS `ArtifactFile` interface (`ts_sdk/src/services/graph-workflows.ts`)
 * declares five. `renderable` is produced by the backend and invisible to every
 * TS consumer — nothing in the type system notices, because an interface is
 * erased at runtime and extra wire keys are silently tolerated.
 *
 * The mechanism for enforcing Python↔TS wire contracts (golden fixture vs
 * runtime validation vs generated types) is an OPEN decision, parked by
 * explicit instruction. This test documents the symptom so nobody rediscovers
 * it mid-implementation, and is written as `it.fails` so `--bail 1` does not
 * halt the chain on it. When the drift is fixed, this test starts failing
 * because it PASSED — flip `it.fails` to `it` and delete this paragraph.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '../../..');

/** The keys the Python route actually puts on the wire, read from source. */
function pythonFileKeys(): string[] {
  const src = readFileSync(resolve(REPO, 'flow_sdk/server/routes/artifacts.py'), 'utf8');
  const block = src.slice(src.indexOf('out.append({'), src.indexOf('})', src.indexOf('out.append({')));
  return [...block.matchAll(/^\s*"([a-z_]+)":/gm)].map((m) => m[1]);
}

/** The keys the TS interface declares, read from source. */
function tsFileKeys(): string[] {
  const src = readFileSync(resolve(REPO, 'ts_sdk/src/services/graph-workflows.ts'), 'utf8');
  const start = src.indexOf('export interface ArtifactFile {');
  const block = src.slice(start, src.indexOf('\n}', start));
  return [...block.matchAll(/^\s{2}([a-z_]+)\??:/gm)].map((m) => m[1]);
}

describe('ArtifactFile wire contract (Python ↔ TS)', () => {
  it('reads both key sets off source, so the drift is measured, not asserted', () => {
    expect(pythonFileKeys()).toContain('renderable');
    expect(tsFileKeys()).toContain('name');
  });

  it.fails('declares every key the backend emits', () => {
    expect(tsFileKeys().sort()).toEqual(pythonFileKeys().sort());
  });
});
