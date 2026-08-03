import { describe, expect, it } from 'vitest';
import {
  ASSET_SOURCE_LABEL,
  READONLY_ASSET_SOURCES,
  assetDescriptorHasUsage,
  assetSourceLabel,
  isReadOnlySource,
  type AssetDescriptor,
  type AssetSource,
} from '@sdk';

const ALL_SOURCES: AssetSource[] = [
  'embedded',
  'inline',
  'project_dir',
  'user_dir',
  'workdir',
  'additional_dir',
  'context_dir',
  'system',
  'external',
];

describe('isReadOnlySource — partition over every AssetSource member', () => {
  // Hand-written expectations: writable iff the source state lives inside
  // this AgenticProcess (embedded materialized copy, or inline cli_config key).
  const expected: Record<AssetSource, boolean> = {
    embedded: false,
    inline: false,
    project_dir: true,
    user_dir: true,
    workdir: true,
    additional_dir: true,
    context_dir: true,
    system: true,
    external: true,
  };

  it.each(ALL_SOURCES)('%s', (source) => {
    expect(isReadOnlySource(source)).toBe(expected[source]);
  });

  it('fails closed on a source this bundle predates', () => {
    // ts_sdk ships separately from the Python wheel, so a stale bundle can meet
    // a source string it has never heard of. Guessing "writable" would hand the
    // user a live editor over whatever it is — e.g. a file inside site-packages.
    expect(isReadOnlySource('some_future_source' as AssetSource)).toBe(true);
    expect(assetSourceLabel('some_future_source' as AssetSource)).toBe('some_future_source');
  });

  it('READONLY_ASSET_SOURCES exactly matches the True set above', () => {
    const expectedRO = ALL_SOURCES.filter((s) => expected[s]).sort();
    const actual = [...READONLY_ASSET_SOURCES].sort();
    expect(actual).toEqual(expectedRO);
  });

  it('ASSET_SOURCE_LABEL covers every source (no missing keys)', () => {
    for (const s of ALL_SOURCES) expect(ASSET_SOURCE_LABEL[s]).toBeTruthy();
  });
});

describe('assetDescriptorHasUsage', () => {
  const base: AssetDescriptor = {
    typeid: 'subagent-11111111-1111-4111-8111-111111111111',
    source: 'embedded',
    posix_path: '/tmp/.claude/agents/vibe.md',
    source_dir: null,
  };

  it('is false when backend usage is absent or empty', () => {
    expect(assetDescriptorHasUsage(base)).toBe(false);
    expect(assetDescriptorHasUsage({ ...base, usage: [] })).toBe(false);
  });

  it('is true for process-active and transcript-backed usage', () => {
    expect(assetDescriptorHasUsage({
      ...base,
      usage: [{ kind: 'embedded_asset', path: base.posix_path }],
    })).toBe(true);
    expect(assetDescriptorHasUsage({
      ...base,
      usage: [{ kind: 'transcript_file_read', path: base.posix_path, entry_id: 'entry-1' }],
    })).toBe(true);
  });

  it('preserves true, false, and omitted remote compatibility states', () => {
    const omitted: AssetDescriptor = { ...base };
    expect(({ ...base, remote: true } satisfies AssetDescriptor).remote).toBe(true);
    expect(({ ...base, remote: false } satisfies AssetDescriptor).remote).toBe(false);
    expect(omitted.remote).toBeUndefined();
  });
});
