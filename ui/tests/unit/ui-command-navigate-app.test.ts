/**
 * `flow navigate entity micro_app-<id>` arrives as a navigate_entity ui_command. A web app's entity
 * class has no view of its own, so the generic fallback sent the tab to the Home screen.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewType } from '@sdk';

const cm = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  ConnectionManager: { getInstance: () => cm },
}));

import { NavigationActions } from '@src/navigation/NavigationActions';
import { useUiCommandListener } from '@src/hooks/use-ui-command-listener';

afterEach(() => {
  cm.on.mockClear();
  vi.restoreAllMocks();
});

describe('navigate_entity for an app', () => {
  it.each(['micro_app', 'service_endpoint'])('a %s opens running, not on Home', async (type) => {
    const commit = vi.spyOn(NavigationActions, 'commitDetached').mockImplementation(() => undefined as never);
    renderHook(() => useUiCommandListener());
    const handler = cm.on.mock.calls.find(([event]) => event === 'on_ui_command')![1];
    const id = '8a51e98b-ed4d-49dc-ab46-a46d4a262e15';
    handler({ kind: 'navigate_entity', type, id });
    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    const pointer = commit.mock.calls[0][0];
    expect(pointer.viewType).toBe(ViewType.APP);
    expect(pointer.pointer).toBe(`${type}-${id}`);
  });
});
