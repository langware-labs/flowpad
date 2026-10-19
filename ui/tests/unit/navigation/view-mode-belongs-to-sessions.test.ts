/**
 * A view mode belongs to a session tab (and a child its workspace hosts).
 * Every other page states none — so no address, and no tab left behind, can
 * give the home or a page a second look.
 */
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewMode } from '@src/contexts/view-mode-context';

const PROC = 'agentic_process-8c98d9c8-4295-4ac4-8560-788d762bd89a';

describe('which docks carry a view mode', () => {
  it.each([
    ['the home', '/?viewMode=advanced'],
    ['the home, by name', '/dock/home?viewMode=standard'],
    ['an assets list', '/dock/assets/list/skill?viewMode=advanced'],
    ['automations', '/dock/automations?viewMode=dev'],
  ])('%s drops a mode from its address', (_what, url) => {
    const dock = DockPointer.fromUrl(url);
    expect(dock.viewMode).toBeNull();
    expect(dock.toUrl()).not.toContain('viewMode');
  });

  it('a page cannot be given one', () => {
    const dock = DockPointer.forAssetList('skill').withViewMode(ViewMode.Advanced);
    expect(dock.viewMode).toBeNull();
  });

  it('a session keeps the mode its address states', () => {
    expect(DockPointer.fromUrl(`/dock/shell/${PROC}?viewMode=advanced`).viewMode).toBe(ViewMode.Advanced);
    expect(DockPointer.fromUrl(`/dock/vibe/${PROC}`).viewMode).toBe(ViewMode.Vibe);
  });

  it('a child a workspace hosts shows in its host mode', () => {
    const child = DockPointer.forAssetList('skill').withHost(PROC).withViewMode(ViewMode.Vibe);
    expect(child.viewMode).toBe(ViewMode.Vibe);
  });
});
