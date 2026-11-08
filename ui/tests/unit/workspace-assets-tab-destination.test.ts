import { afterEach, expect, it } from 'vitest';
import { Tab } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';

const HOST = 'agentic_process-f5150b1e-ed3a-409f-aa3d-1692544a0d34';
const TARGET = '568c524b-e48f-43b0-915f-08f12ea85481';
const CONTENT = `editor/markdown/typeid/markdown-${TARGET}`;
afterEach(() => NavigationActions.resetPendingNavigationForTests());

it('reopens a persisted Assets child through the strip navigation path inside its session', () => {
  const tab = new Tab({
    pointer: JSON.stringify({
      viewType: 'assets',
      pointer: '',
      tabHash: `assets|all|@${HOST}`,
      workspaceContent: true,
    }),
    parent_tab_id: 'b76be753-8909-5d1d-9a99-4a982e53ffb4',
    target_type: 'markdown',
    target_id: TARGET,
  });
  window.history.replaceState({}, '', `/dock/vibe/${HOST}`);
  const navigation = new NavigationActions((url) => {
    if (typeof url !== 'string') throw new Error('Expected a dock URL');
    window.history.pushState({}, '', url);
  });
  navigation.openDock(tab.dockPointer!);
  expect(window.location.pathname).toBe(`/dock/assets/${CONTENT}`);
  expect(new URLSearchParams(window.location.search).get('host')).toBe(HOST);
});

it('persists the destination of a hosted Assets document without changing its tab key', () => {
  const dock = DockPointer.fromUrl(`/dock/assets/${CONTENT}?host=${HOST}`);
  const tab = new Tab({ pointer: dock.toJSON()! });
  expect(tab.dockPointer?.pointer).toBe(CONTENT);
  expect(tab.dockPointer?.tabHash).toBe(dock.tabHash);
});

it('keeps the top-level Assets browser at its root even when it last showed a document', () => {
  const dock = DockPointer.fromUrl(`/dock/assets/${CONTENT}`);
  const tab = new Tab({ pointer: dock.toJSON()!, target_type: 'markdown', target_id: TARGET });
  expect(tab.dockPointer?.pointer).toBe('');
});
