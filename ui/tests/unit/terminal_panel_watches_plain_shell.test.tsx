/**
 * The backend revives a terminal after it restarts only if a UI is watching it
 * (pty_recovery `_recover_bare_shells`, gated on the `shell:<id>` watch). The
 * plain-shell pane read its shell without watching, so after a backend restart
 * the recovery never ran and the open terminal stayed dead until a reload.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tab } from '@sdk';

const calls: Array<{ type?: string; id?: string; watch?: boolean }> = [];

vi.mock('@src/hooks/entity-hooks', () => ({
  useEntity: (typeId: { type: string; id: string } | null, opts?: { watch?: boolean }) => {
    if (typeId) calls.push({ type: typeId.type, id: typeId.id, watch: opts?.watch });
    return { data: undefined };
  },
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock: vi.fn() } }),
  useCurrentDock: () => null,
}));
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ flow: null, project: null }),
}));

import { TerminalPanel } from '@src/components/terminal/TerminalPanel';

const SHELL_ID = '76688a8a-fa35-4d3b-a5be-d6fc8d432d7e';

describe('plain-shell terminal pane', () => {
  afterEach(() => {
    cleanup();
    calls.length = 0;
  });

  it('watches its shell so the backend revives it after a restart', () => {
    const tab = new Tab({ id: 'tab-1', target_type: 'shell', target_id: SHELL_ID } as never);
    render(<TerminalPanel tab={tab} isActive />);
    expect(calls).toContainEqual({ type: 'shell', id: SHELL_ID, watch: true });
  });
});
