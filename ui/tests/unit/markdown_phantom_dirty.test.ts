/**
 * Captures the "skill editor stuck on Loading…" RCA (the autoversion storm).
 *
 * Proven root cause (this session): opening a frontmatter asset in the markdown
 * editor marks it dirty with NO user edit, because the editor's own
 * parse→serialize of the *unchanged* on-disk content is not idempotent —
 * `serializeFrontmatter` re-quotes every scalar (so an on-disk `name: rca` /
 * `version: 131` comes back as `name: "rca"` / `version: "131"`). The dirty flag
 * is `content !== remoteContent` (use-fs-ref-content.ts:96); since the
 * round-tripped content differs from disk, dirty flips true on mount → autosave
 * fires `fs.write` → the backend autoversion hook bumps `version` + git-commits
 * EVERY open. That is the loop that ran the real rca/SKILL.md from v96 → v131
 * in one session and wedged the backend, leaving the editor on "Loading skill…".
 *
 * The narrowest faithful layer is the pure pair the editor buffer is built from.
 * The invariant a non-dirtying editor MUST hold: serializing the parse of
 * already-on-disk content reproduces it byte-for-byte (round-trip = identity).
 * It does not — this test fails on exactly that inequality and will pass once the
 * serializer round-trips on-disk YAML (or `dirty` compares normalized forms).
 *
 * No mocks: the real `parseFrontmatter` / `serializeFrontmatter` from the hook,
 * and the real on-disk SKILL.md that actually stormed.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { normalizeMarkdownForCompare, parseFrontmatter, serializeFrontmatter } from '@src/hooks/use-markdown-content';

const roundTrip = (raw: string): string => {
  const { fields, body } = parseFrontmatter(raw);
  return serializeFrontmatter(fields, body);
};

describe('markdown editor phantom-dirty (autoversion storm root)', () => {
  it('round-trips a real-shaped frontmatter asset to itself (else every open is dirty)', () => {
    // The exact frontmatter shape of the real rca SKILL.md: unquoted `name`,
    // unquoted numeric `version`. This is what lives on disk after the backend's
    // autoversion canonicalizer writes it.
    const onDisk = ['---', 'name: rca', "tags: ''", "eval: 'false'", 'version: 131', '---', '', '# RCA', 'body', ''].join('\n');

    // A clean editor must not consider unchanged on-disk content "edited":
    // serialize(parse(x)) === x. The bug is precisely that it isn't.
    expect(roundTrip(onDisk)).toBe(onDisk);
  });

  it('round-trips the actual rca/SKILL.md that stormed v96→v131', () => {
    const skillPath = resolve(__dirname, '../../../.claude/skills/rca/SKILL.md');
    let onDisk: string;
    try {
      onDisk = readFileSync(skillPath, 'utf-8');
    } catch {
      // The file is the live trigger; if it's absent in this checkout, the
      // inline case above already proves the invariant. Skip rather than error.
      return;
    }
    expect(roundTrip(onDisk)).toBe(onDisk);
  });

  it('dirty comparator (hardening) treats reformatted-but-unedited content as NOT dirty', () => {
    const onDisk = ['---', 'name: rca', "eval: 'false'", 'version: 131', '---', '', '# RCA', 'body', ''].join('\n');

    // The old "quote everything" serializer output — byte-different, semantically
    // identical. Even if the serializer regresses to this, dirty must stay false.
    const reEmitted = ['---', 'name: "rca"', 'eval: "false"', 'version: "131"', '---', '', '# RCA', 'body  ', ''].join('\n');

    expect(reEmitted).not.toBe(onDisk); // byte-different (proves the trap is real)
    expect(normalizeMarkdownForCompare(reEmitted)).toBe(normalizeMarkdownForCompare(onDisk)); // but NOT dirty

    // A real edit must still register as dirty.
    const edited = onDisk.replace('body', 'body changed');
    expect(normalizeMarkdownForCompare(edited)).not.toBe(normalizeMarkdownForCompare(onDisk));
  });
});
