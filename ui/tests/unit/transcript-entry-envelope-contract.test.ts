/**
 * The transcript-entry ENVELOPE is a Python↔TS wire contract, and it drifted:
 * `BaseEntry` was missing `attribution_skill` long before this change, and its
 * `EntryKind` union lacked `compaction` and `artifact`. Nothing noticed —
 * a TS interface is erased at runtime, so a missing field is invisible until a
 * consumer needs it and finds `undefined`.
 *
 * So pin both sides against SOURCE (the same technique as
 * `artifact-file-wire-contract.test.ts`): the Python `EntryKind` enum members
 * and `TranscriptEntry.to_dict()`'s keys are the authority; the TS union and
 * `BaseEntry` must match them exactly. A new Python kind or envelope field now
 * fails here instead of silently not existing on the client.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '../../..');

const pythonSrc = (): string =>
  readFileSync(resolve(REPO, 'flow_sdk/transcript_analyzer/entry.py'), 'utf8');

const tsSrc = (): string =>
  readFileSync(resolve(REPO, 'ts_sdk/src/utils/agent-transcript/entries.ts'), 'utf8');

/** `EntryKind` members, read as their string VALUES (the wire form). */
function pythonEntryKinds(): string[] {
  const src = pythonSrc();
  const start = src.indexOf('class EntryKind(str, Enum):');
  const block = src.slice(start, src.indexOf('\n\n\nclass ', start));
  return [...block.matchAll(/^\s{4}[A-Z_]+ = "([a-z_]+)"$/gm)].map((m) => m[1]);
}

/** Keys `TranscriptEntry.to_dict()` puts on the wire for EVERY entry. */
function pythonEnvelopeKeys(): string[] {
  const src = pythonSrc();
  const start = src.indexOf('    def to_dict(self) -> dict:');
  const block = src.slice(start, src.indexOf('\n    # ──', start));
  return [...block.matchAll(/^\s+"([a-z_]+)": self\./gm)].map((m) => m[1]);
}

function tsEntryKinds(): string[] {
  const src = tsSrc();
  const start = src.indexOf('export type EntryKind =');
  const block = src.slice(start, src.indexOf(';', start));
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

function tsBaseEntryFields(): string[] {
  const src = tsSrc();
  const start = src.indexOf('export interface BaseEntry {');
  const block = src.slice(start, src.indexOf('\n}', start));
  return [...block.matchAll(/^\s{2}([a-z_]+)\??:/gm)].map((m) => m[1]);
}

describe('transcript entry envelope (Python ↔ TS)', () => {
  it('reads both sides off source, so the contract is measured, not asserted', () => {
    expect(pythonEntryKinds()).toContain('tool_use');
    expect(pythonEnvelopeKeys()).toContain('session_id');
    expect(tsEntryKinds()).toContain('tool_use');
    expect(tsBaseEntryFields()).toContain('session_id');
  });

  it('declares every EntryKind the Python enum defines', () => {
    expect([...tsEntryKinds()].sort()).toEqual([...pythonEntryKinds()].sort());
  });

  it('declares every envelope field to_dict emits', () => {
    expect([...tsBaseEntryFields()].sort()).toEqual([...pythonEnvelopeKeys()].sort());
  });

  it('carries the derivation-layer envelope: virtual + derived_from', () => {
    // Named explicitly, not just via the set comparison, because these two are
    // what the UI's generic drop rule reads — a rename on either side must read
    // as a broken contract here rather than as a chip that stopped rendering.
    expect(tsBaseEntryFields()).toEqual(expect.arrayContaining(['virtual', 'derived_from']));
    expect(pythonEnvelopeKeys()).toEqual(expect.arrayContaining(['virtual', 'derived_from']));
  });
});
