// The UI actions the smart navigator can answer with: the backend's catalog names them, this
// side carries them out -- one handler per id, no more, no fewer.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgenticProcess } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { requestUiAction, UI_ACTIONS, useUiActionRequest } from '@src/navigation/ui-actions';
import type { UiActionHost } from '@src/navigation/ui-actions';

const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../../flow_sdk/core/ui_actions.json'), 'utf8')) as {
  actions: Record<string, string>;
};

function Host({ ids, onRun }: { ids: string[]; onRun: (id: string) => void }) {
  useUiActionRequest(ids, onRun);
  return null;
}

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.view_mode_switch.rules: FAILING? read this tag's rules before
//       changing switchMode or DockPointer's view-mode drop
// flowpad:endcapsule tag
describe('UI actions', () => {
  it('every action the navigator can pick has a handler, and every handler is in the catalog', () => {
    expect(Object.keys(UI_ACTIONS).sort()).toEqual(Object.keys(catalog.actions).sort());
  });

  it('a request reaches a host that is already showing', () => {
    const onRun = vi.fn();
    render(<Host ids={['publish-dialog']} onRun={onRun} />);
    requestUiAction('publish-dialog');
    expect(onRun).toHaveBeenCalledWith('publish-dialog');
  });

  it('a request made before its screen opened is taken when the host mounts -- once', () => {
    requestUiAction('upload-flowmsg');
    const first = vi.fn();
    const second = vi.fn();
    render(<Host ids={['upload-flowmsg']} onRun={first} />);
    render(<Host ids={['upload-flowmsg']} onRun={second} />);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  // Live (navigation sentences 178/179): "switch to terminal mode" on Home re-pointed Home at
  // ?viewMode=advanced, which DockPointer drops off a session -- the same URL, so nothing happened.
  it('a mode switch off a session page opens the last chat in that mode', async () => {
    const id = '7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d';
    // A queried process's `terminalDockPointer` is the SDK's plain pointer (no `withViewMode`): live,
    // re-pointing it threw. The session is shown on the surface by id, as its own switch does.
    const chat = { id, terminalDockPointer: { viewType: 'shell', pointer: `agentic_process-${id}` } };
    vi.spyOn(AgenticProcess, 'query').mockResolvedValue([chat as unknown as AgenticProcess]);
    const openDock = vi.fn();
    const switchSessionSurface = vi.fn();
    const host = { navigation: { here: DockPointer.fromUrl('/dock/home'), openDock, switchSessionSurface }, toggleTheme: vi.fn() };
    await UI_ACTIONS['view-mode-advanced'](host as unknown as UiActionHost);
    expect(switchSessionSurface).toHaveBeenCalledWith(id, 'advanced');
    expect(openDock).not.toHaveBeenCalled();
  });

  it('on a session page it re-points that session', async () => {
    const openDock = vi.fn();
    const here = DockPointer.forSession('7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d');
    await UI_ACTIONS['view-mode-vibe']({ navigation: { here, openDock }, toggleTheme: vi.fn() } as unknown as UiActionHost);
    expect((openDock.mock.calls[0][0] as DockPointer).viewMode).toBe('vibe');
  });

  it('a host only hears the actions it names', () => {
    const onRun = vi.fn();
    render(<Host ids={['settings-dialog']} onRun={onRun} />);
    requestUiAction('bookmarks-menu');
    expect(onRun).not.toHaveBeenCalled();
  });
});
