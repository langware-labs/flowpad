/**
 * `resolveTabProject` — THE rule order for a tab's project (docs/tab-management.md
 * §tab project), one row per scenario. The backend's `resolve_tab_project` is the
 * same order; a row here and there must agree.
 */
import { AgenticProcess, dataContext, dataManager, Project, resolveTabProject, tabOwnerProject, TypeId, type TabProjectTarget } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { projectScope } from '@src/lib/scope-filter';
import { ViewType } from '@src/types/ViewType';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWN = '11111111-1111-4111-8111-111111111111'; // the asset's own project
const URLP = '22222222-2222-4222-8222-222222222222'; // the project a URL presents it in
const OUTER = '33333333-3333-4333-8333-333333333333'; // /w
const INNER = '44444444-4444-4444-8444-444444444444'; // /w/inner (nested mount)
const ACTIVE = '55555555-5555-4555-8555-555555555555';
const ASSET = '66666666-6666-4666-8666-666666666666';
const PROC = '77777777-7777-4777-8777-777777777777';
const FOLDER = '88888888-8888-5888-8888-888888888888'; // a non-project folder's derived id

const MOUNTS: Record<string, string> = { '/w/inner': INNER, '/w': OUTER };
const PROJECTS = new Set([OWN, URLP, OUTER, INNER, ACTIVE]);

beforeEach(() => {
  // Deepest mount holding the path — the cached project list's answer.
  vi.spyOn(Project, 'getProjectByPath').mockImplementation(async (path) => {
    const hit = Object.keys(MOUNTS)
      .sort((a, b) => b.length - a.length)
      .find((m) => path === m || path?.startsWith(`${m}/`));
    return hit ? ({ id: MOUNTS[hit] } as Project) : null;
  });
  // The project rows that exist; any other project id is a 404.
  vi.spyOn(dataManager, 'getByTypeId').mockImplementation((typeId) =>
    Promise.resolve(typeId.type === Project.type && PROJECTS.has(typeId.id) ? ({ id: typeId.id } as never) : null),
  );
  vi.spyOn(dataContext, 'getContextEntity').mockReturnValue({ id: ACTIVE } as never);
});
afterEach(() => vi.restoreAllMocks());

const asset = (project_id: string | null): TabProjectTarget => ({
  typeId: new TypeId('markdown', ASSET),
  project_id,
});
const vfsDoc = DockPointer.forAssetEditor('markdown', '/w/inner/docs/a.md');
const typeidDoc = DockPointer.forAssetEditorByTypeId('markdown', new TypeId('markdown', ASSET));

interface Case {
  name: string;
  dock: DockPointer;
  target: TabProjectTarget;
  want: string | null;
  owner: string | null;
}

const CASES: Case[] = [
  { name: 'typeid asset → its own project', dock: typeidDoc, target: asset(OWN), want: OWN, owner: OWN },
  { name: 'vfs asset → its own project', dock: vfsDoc, target: asset(OWN), want: OWN, owner: OWN },
  {
    name: 'a stamp naming no project (a non-project folder) → its path decides',
    dock: vfsDoc,
    target: asset(FOLDER),
    want: INNER,
    owner: INNER,
  },
  {
    name: 'a typeid asset stamped with a non-project folder id → global',
    dock: typeidDoc,
    target: asset(FOLDER),
    want: null,
    owner: null,
  },
  {
    name: 'unminted file in a nested mount → the deepest project folder',
    dock: vfsDoc,
    target: null,
    want: INNER,
    owner: INNER,
  },
  {
    name: '`flow show` rebased onto another project → a guest of the URL project',
    dock: DockPointer.rebaseAssetsOntoProject(vfsDoc, URLP),
    target: asset(OWN),
    want: URLP,
    owner: OWN,
  },
  {
    name: 'scope-pinned Assets list → its scope project',
    dock: DockPointer.forAssetList('all', { scope: projectScope(URLP) }),
    target: null,
    want: URLP,
    owner: null,
  },
  {
    name: 'a scoped Assets EDITOR is content: its asset wins, not the scope',
    dock: vfsDoc.withScopeFilter(projectScope(URLP)),
    target: asset(OWN),
    want: OWN,
    owner: OWN,
  },
  {
    name: 'unscoped web page → the active project',
    dock: DockPointer.forWebUrl('https://example.com/'),
    target: null,
    want: ACTIVE,
    owner: null,
  },
  {
    name: 'session shell with no project → its workdir project',
    dock: DockPointer.forSession(PROC),
    target: { typeId: new TypeId(AgenticProcess.type, PROC), project_id: null, workdir: '/w/x' },
    want: OUTER,
    owner: OUTER,
  },
  {
    name: 'lens on a target with a project → that project',
    dock: DockPointer.forLensTranscript('claude', ASSET),
    target: { typeId: new TypeId('claude_session', ASSET), project_id: OWN, cwd: '/w/inner' },
    want: OWN,
    owner: OWN,
  },
  { name: 'project home → the project itself', dock: DockPointer.forProject(URLP), target: null, want: URLP, owner: URLP },
  {
    name: 'dependency home → its consumer project',
    dock: new DockPointer(ViewType.PROJECT, OWN, { providerProject: OWN, consumerProject: URLP }),
    target: null,
    want: URLP,
    owner: OWN,
  },
  {
    name: 'an existing target outside every project → global',
    dock: typeidDoc,
    target: asset(null),
    want: null,
    owner: null,
  },
];

describe('resolveTabProject', () => {
  it.each(CASES)('$name', async ({ dock, target, want, owner }) => {
    expect(await resolveTabProject(dock, target)).toBe(want);
    expect(await tabOwnerProject(dock, target)).toBe(owner);
  });
});
