import { describe, expect, it } from 'vitest';
import {
  ASSET_SOURCE_LABEL,
  READONLY_ASSET_SOURCES,
  isReadOnlySource,
  type AssetSource,
} from '@sdk';

const ALL_SOURCES: AssetSource[] = [
  'embedded',
  'inline',
  'project_dir',
  'user_dir',
  'workdir',
  'additional_dir',
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
  };

  it.each(ALL_SOURCES)('%s', (source) => {
    expect(isReadOnlySource(source)).toBe(expected[source]);
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
