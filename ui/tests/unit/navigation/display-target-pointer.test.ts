/**
 * Unit tests for `dockForDisplayTarget` — the ONE rule mapping a resolved
 * `flow show` target (`flow_sdk/core/display_target.py`) to the dock it opens.
 *
 * Both view modes route through this: vibe uses it for the display-history
 * popover, every other mode mints a tab from it. Before it existed the rule was
 * three near-copies that had already drifted (one used `editorForPath`, another
 * the wider `dockPointerForFile` chokepoint), so the cases that matter here are
 * the ones where the copies disagreed and the two deliberate `null`s.
 */
import { describe, expect, it } from 'vitest';
import { dockForDisplayTarget } from '@src/navigation/display-target-pointer';
import { ViewType } from '@src/types/ViewType';

const UUID = 'd864c29b-69fc-4b8d-b748-1526a83f598a';

describe('dockForDisplayTarget', () => {
  it('opens an entity with a registered editor by TypeId', () => {
    const dock = dockForDisplayTarget({ kind: 'entity', type: 'markdown', id: UUID, typeid: `markdown-${UUID}` });
    expect(dock?.viewType).toBe(ViewType.ASSETS);
    expect(dock?.pointer).toContain(`typeid/markdown-${UUID}`);
  });

  it('opens a vfs path through the shared file chokepoint', () => {
    const dock = dockForDisplayTarget({ kind: 'vfs', path: '/tmp/proj/hello.md' });
    // `dockPointerForFile` routes markdown to the markdown editor, NOT the code
    // editor — this is the case the two old copies disagreed on.
    expect(dock).not.toBeNull();
    expect(dock?.pointer).toContain('markdown');
    expect(dock?.pointer).toContain('hello.md');
  });

  it('falls back to the path when the entity type has no registered editor', () => {
    const dock = dockForDisplayTarget({ kind: 'entity', type: 'dataset', id: UUID, path: '/tmp/proj/notes.md' });
    expect(dock?.pointer).toContain('notes.md');
  });

  it('addresses an app by its ARTIFACT, keeping the endpoint derived', () => {
    // The endpoint the backend picked rides along but is not the address: which
    // endpoint serves an app changes without the app changing.
    const dock = dockForDisplayTarget({
      kind: 'app',
      artifact_id: UUID,
      endpoint_id: 'e1',
      typeid: `artifact-${UUID}`,
      runtime: 'dev',
    });
    expect(dock?.viewType).toBe(ViewType.APP);
    expect(dock?.pointer).toBe(`artifact-${UUID}`);
    expect(dock?.options?.port).toBeUndefined();
    // The runtime rides in options, so it stays out of tab identity: flipping
    // dev⇄served re-points the same tab instead of forking one per runtime.
    expect(dock?.options?.runtime).toBe('dev');
    expect(dock?.tabHash).toBe(`app|artifact-${UUID}`);
  });

  it('addresses a served or unbuilt app too — the case that used to have no URL', () => {
    for (const runtime of ['served', 'unbuilt'] as const) {
      const dock = dockForDisplayTarget({ kind: 'app', artifact_id: UUID, typeid: `artifact-${UUID}`, runtime });
      expect(dock?.viewType).toBe(ViewType.APP);
      expect(dock?.pointer).toBe(`artifact-${UUID}`);
    }
    // `unbuilt` is not a runtime the viewer can select, so it is not pinned.
    const unbuilt = dockForDisplayTarget({ kind: 'app', artifact_id: UUID, typeid: `artifact-${UUID}`, runtime: 'unbuilt' });
    expect(unbuilt?.options?.runtime).toBeUndefined();
  });

  it('addresses a bare dev server by its ENDPOINT, never its port', () => {
    // `flow show webapp --port N` registers a proxy endpoint and shows THAT.
    const dock = dockForDisplayTarget({
      kind: 'app',
      typeid: `service_endpoint-${UUID}`,
      endpoint_id: UUID,
      runtime: 'dev',
    });
    expect(dock?.viewType).toBe(ViewType.APP);
    expect(dock?.pointer).toBe(`service_endpoint-${UUID}`);
    expect(dock?.options).toEqual({ runtime: 'dev' });
  });

  it('addresses a webapp asset by its definition', () => {
    const dock = dockForDisplayTarget({ kind: 'app', typeid: `micro_app-${UUID}`, micro_app_id: UUID, runtime: 'served' });
    expect(dock?.pointer).toBe(`micro_app-${UUID}`);
  });

  it('routes a shell target to its terminal dock, not an editor', () => {
    // A shell target also carries type/id; without the shell check first it
    // would fall through to the entity branch and resolve to no editor.
    const dock = dockForDisplayTarget({ kind: 'shell', type: 'shell', id: UUID, typeid: `shell-${UUID}` });
    expect(dock?.viewType).toBe(ViewType.SHELL);
    expect(dock?.pointer).toBe(UUID);
  });

  describe('returns null — a real answer, not a failure', () => {
    it('for an entity with neither a registered editor nor a path', () => {
      expect(dockForDisplayTarget({ kind: 'entity', type: 'dataset', id: UUID })).toBeNull();
    });

    it('for an app with no typeid to address it by', () => {
      expect(dockForDisplayTarget({ kind: 'app', runtime: 'unbuilt' })).toBeNull();
    });

    it('for a null/undefined target', () => {
      expect(dockForDisplayTarget(null)).toBeNull();
      expect(dockForDisplayTarget(undefined)).toBeNull();
    });
  });
});
