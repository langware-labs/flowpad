import { describe, expect, it } from 'vitest';

import {
  bodyCopyKey,
  bootstrapCommand,
  filterItems,
  fromDirectoryRow,
  fromPublished,
  fromUnpublished,
  installCommand,
  projectFacets,
  provenanceOf,
  sortItems,
  STATE_STYLE,
  typeFacets,
  type DiscoverItem,
} from '@src/pages/discover-page/discover-model';
import type { DirectoryRow, PublishedState } from '@sdk';

const GIT = { kind: 'git', provider: 'github', owner: 'acme', name: 'tools', branch: 'main', rel_path: '.claude/skills/rca' };

function row(over: Partial<DirectoryRow> = {}): DirectoryRow {
  return {
    typeid: 'skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    type: 'skill',
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'rca',
    description: 'root cause',
    rel_path: '.claude/skills/rca',
    published_at: '2026-09-09T00:00:00Z',
    state: 'install',
    origin: GIT,
    source_project_id: 'p1',
    source_project_name: 'alpha',
    body_supported: true,
    body_available: false,
    body_reason: 'not_on_hub',
    body_ref: null,
    ...over,
  };
}

describe('discover-model', () => {
  it('maps the three row shapes onto one item', () => {
    const hub = fromDirectoryRow(row());
    expect([hub.sourceProjectName, hub.body?.body_reason, hub.hubBody]).toEqual(['alpha', 'not_on_hub', null]);
    const desk = fromPublished({ ...row(), hub_body: { status: 'skipped', code: 'project_not_linked' }, posix_path: '/p/x' }, { id: 'p9', name: 'mine' });
    expect([desk.sourceProjectId, desk.posixPath, desk.hubBody?.code, desk.body]).toEqual(['p9', '/p/x', 'project_not_linked', null]);
    const cand = fromUnpublished({ typeid: 'markdown-cccccccc-cccc-4ccc-8ccc-cccccccccccc', type: 'markdown', name: 'guide', posix_path: '/p/g.md', project_id: 'p9' }, null);
    expect([cand.id, cand.state, cand.publishedAt]).toEqual(['cccccccc-cccc-4ccc-8ccc-cccccccccccc', null, null]);
  });

  it('filters by query, type and project; sorts newest first with candidates last', () => {
    const a = fromDirectoryRow(row({ name: 'alpha-skill', published_at: '2026-09-01T00:00:00Z' }));
    const b = fromDirectoryRow(row({ typeid: 'markdown-dddddddd-dddd-4ddd-8ddd-dddddddddddd', type: 'markdown', name: 'beta-doc', published_at: '2026-09-09T00:00:00Z', source_project_id: 'p2', source_project_name: 'beta' }));
    const c: DiscoverItem = { ...a, typeid: 'skill-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'candidate', state: null, publishedAt: null };
    expect(filterItems([a, b, c], { query: 'BETA' }).map((i) => i.name)).toEqual(['beta-doc']);
    expect(filterItems([a, b, c], { type: 'skill' }).map((i) => i.name)).toEqual(['alpha-skill', 'candidate']);
    expect(filterItems([a, b, c], { projectId: 'p2' }).map((i) => i.name)).toEqual(['beta-doc']);
    expect(sortItems([c, a, b], 'published_at').map((i) => i.name)).toEqual(['beta-doc', 'alpha-skill', 'candidate']);
    expect(sortItems([b, a], 'name').map((i) => i.name)).toEqual(['alpha-skill', 'beta-doc']);
    expect(typeFacets([a, b, c])).toEqual([{ type: 'skill', count: 2 }, { type: 'markdown', count: 1 }]);
    expect(projectFacets([a, b, c])).toEqual([{ id: 'p1', name: 'alpha', count: 2 }, { id: 'p2', name: 'beta', count: 1 }]);
  });

  it('names the commands', () => {
    expect(installCommand('skill-x')).toBe('flow asset install skill-x');
    expect(bootstrapCommand()).toBe('uv tool install flowpad && flow start && flow auth login');
  });

  it('reads provenance off the origin', () => {
    expect(provenanceOf(GIT)).toEqual({ kind: 'git', label: 'acme/tools@main', href: 'https://github.com/acme/tools/tree/main/.claude/skills/rca', provider: 'github' });
    expect(provenanceOf({ kind: 'local', base: '/x', rel_path: 'y' })).toEqual({ kind: 'local' });
    expect(provenanceOf(null)).toBeNull();
  });

  it('styles every published state and explains every missing body', () => {
    const states: PublishedState[] = ['in_use', 'install', 'stale', 'missing'];
    states.forEach((s) => expect(STATE_STYLE[s].chip).toContain('dark:'));
    const base = fromDirectoryRow(row());
    expect(bodyCopyKey(base)).toBe('not_on_hub_git');
    expect(bodyCopyKey({ ...base, origin: { kind: 'local' } })).toBe('not_on_hub_local');
    expect(bodyCopyKey(fromDirectoryRow(row({ body_supported: false, body_reason: 'type_not_git' })))).toBe('type_not_git');
    expect(bodyCopyKey(fromDirectoryRow(row({ body_reason: 'not_materialized' })))).toBe('not_materialized');
    expect(bodyCopyKey(fromDirectoryRow(row({ body_available: true, body_reason: null, body_ref: { type_id: 'skill-x', path: 'SKILL.md' } })))).toBeNull();
    const desk = fromPublished({ ...row(), hub_body: { status: 'skipped', code: 'github_not_connected' } }, null);
    expect(bodyCopyKey(desk)).toBe('github_not_connected');
    expect(bodyCopyKey({ ...desk, hubBody: { status: 'failed', code: 'branch_ahead' } })).toBe('publish_failed');
  });
});
