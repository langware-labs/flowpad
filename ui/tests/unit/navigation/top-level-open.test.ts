/**
 * A tab opened from the global strip's "+" is a TOP-LEVEL tab: a terminal opened
 * while a Vibe tab is on screen sits BESIDE it in the strip, not inside it as a
 * nested child, and is not painted in Vibe. (Without `topLevel`, `hostToCarry`
 * adopts a plain terminal into the Vibe workspace on screen — that is right for a
 * terminal opened from INSIDE the workspace, and wrong for the strip.)
 */
import { describe, expect, it, vi } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';

const PROC = 'agentic_process-aaaa1111-1111-4111-8111-111111111111';
const SHELL = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

function navigateFrom(fromUrl: string, target: DockPointer, topLevel: boolean): string {
  NavigationActions.resetPendingNavigationForTests();
  window.history.pushState({}, '', fromUrl);
  const navigate = vi.fn();
  new NavigationActions(navigate, DockPointer.fromUrl(fromUrl)).openDock(target, undefined, topLevel ? { topLevel } : undefined);
  return String(navigate.mock.calls[0][0]);
}

describe('opening a top-level tab from a Vibe tab', () => {
  const terminal = DockPointer.fromUrl(`/dock/shell/${SHELL}`);

  it('a terminal opened INSIDE the workspace is its child (host carried, Vibe)', () => {
    const url = navigateFrom(`/dock/vibe/${PROC}`, terminal, false);
    expect(url).toContain(`host=${PROC}`);
    expect(url).toContain('viewMode=vibe');
  });

  it('a terminal opened from the strip is a top-level tab, not Vibe', () => {
    const url = navigateFrom(`/dock/vibe/${PROC}`, terminal, true);
    expect(url).not.toContain('host=');
    expect(url).not.toContain('viewMode=vibe');
    expect(url).toContain(`/dock/shell/${SHELL}`);
  });

  it('a Vibe chip clicked from another Vibe tab stays a Vibe tab', () => {
    const other = DockPointer.fromUrl('/dock/vibe/agentic_process-bbbb2222-2222-4222-8222-222222222222');
    const url = navigateFrom(`/dock/vibe/${PROC}`, other, true);
    expect(url).toContain('/dock/vibe/agentic_process-bbbb2222');
    expect(url).not.toContain('host=');
  });
});
