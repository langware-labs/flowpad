import { describe, it, expect } from 'vitest';
import { groupRecords } from '@src/components/browseable-tree/adapters/assetTypeRoot';
import type { SearchResult } from '@src/hooks/use-asset-search';

function rec(partial: Partial<SearchResult>): SearchResult {
  return {
    record_id: partial.record_id ?? 'rid',
    record_type: partial.record_type ?? 'skill',
    name: partial.name ?? 'name',
    snippet: null,
    status: '',
    scope: partial.scope ?? '',
    asset_ref: partial.asset_ref ?? '/p',
    created_at: '',
    modified_at: '',
    project_encoded: partial.project_encoded,
    project_encoded_name: partial.project_encoded_name,
  };
}

describe('groupRecords', () => {
  it('returns [] for empty input', () => {
    expect(groupRecords([])).toEqual([]);
  });

  it('groups all-user records under a single User bucket', () => {
    const groups = groupRecords([
      rec({ scope: 'user', name: 'a' }),
      rec({ scope: 'user', name: 'b' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('user');
    expect(groups[0].label).toBe('User');
    expect(groups[0].records).toHaveLength(2);
  });

  it('splits user + multiple projects, User first then projects alpha', () => {
    const groups = groupRecords([
      rec({ scope: 'project', project_encoded: 'p2', project_encoded_name: 'zeta-proj', name: 'r1' }),
      rec({ scope: 'user', name: 'r2' }),
      rec({ scope: 'project', project_encoded: 'p1', project_encoded_name: 'alpha-proj', name: 'r3' }),
      rec({ scope: 'project', project_encoded: 'p1', project_encoded_name: 'alpha-proj', name: 'r4' }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['User', 'alpha-proj', 'zeta-proj']);
    expect(groups[1].records).toHaveLength(2);
    expect(groups[2].records).toHaveLength(1);
  });

  it('drops records with neither user nor project scope', () => {
    const groups = groupRecords([
      rec({ scope: '', name: 'orphan' }),
      rec({ scope: 'system', name: 'sys' }),
      rec({ scope: 'user', name: 'u' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('User');
    expect(groups[0].records).toHaveLength(1);
  });

  it('falls back to project_encoded as label when name is missing', () => {
    const groups = groupRecords([
      rec({ scope: 'project', project_encoded: 'p-uuid', name: 'r' }),
    ]);
    expect(groups[0].label).toBe('p-uuid');
  });
});
