/**
 * "Switch to chat / terminal / Vibe" moves ONE session between its three surfaces
 * with the footer's own switch: the same tab (the session's dock), the requested
 * mode, marked as a switch so it is recorded.
 */
import { describe, expect, it, vi } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { ViewMode } from '@src/contexts/view-mode-context';

const ID = 'aaaa1111-1111-4111-8111-111111111111';

function switchFrom(fromUrl: string, mode: ViewMode): { url: string; state: unknown } {
  NavigationActions.resetPendingNavigationForTests();
  window.history.pushState({}, '', fromUrl);
  const navigate = vi.fn();
  new NavigationActions(navigate, DockPointer.fromUrl(fromUrl)).switchSessionSurface(ID, mode);
  return { url: String(navigate.mock.calls[0][0]), state: navigate.mock.calls[0][1]?.state };
}

describe('session surface switch', () => {
  it('terminal → chat: the session dock in Chat, marked as a switch', () => {
    const { url, state } = switchFrom(`/dock/shell/agentic_process-${ID}?viewMode=advanced`, ViewMode.Standard);
    expect(url).toContain(`/dock/shell/agentic_process-${ID}`);
    expect(url).toContain('viewMode=standard');
    expect(state).toBeTruthy();
  });

  it('chat → Vibe: the Vibe host dock', () => {
    const { url } = switchFrom(`/dock/shell/agentic_process-${ID}?viewMode=standard`, ViewMode.Vibe);
    expect(url).toContain(`/dock/vibe/agentic_process-${ID}`);
  });

  it('Vibe → terminal, from a child the workspace shows', () => {
    const { url } = switchFrom(
      `/dock/editor/notes.md?viewMode=vibe&host=agentic_process-${ID}`,
      ViewMode.Advanced,
    );
    expect(url).toContain(`/dock/shell/agentic_process-${ID}`);
    expect(url).toContain('viewMode=advanced');
    expect(url).not.toContain('host=');
  });
});
