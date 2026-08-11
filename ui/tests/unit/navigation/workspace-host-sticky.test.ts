/**
 * The workspace host is STICKY: `openDock` carries it from the live URL onto any
 * target that may live inside a workspace, the same way `journeyId` rides along.
 *
 * This is what replaces the ambient `tabManager.setActiveParentTabId` global —
 * and it is the only thing that keeps a click INSIDE workspace A in workspace A.
 * One document is one tab however many agents display it, so the document row's
 * `parent_tab_id` is last-writer-wins: a doc shown by A and later by B points at
 * B. Resolving the host from the tab row at click time would therefore teleport
 * a user out of A into B. Carrying it from the URL cannot.
 */
import { describe, expect, it, vi } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { ViewType } from '@src/types/ViewType';

const PROJ = 'dd682350-c185-52c9-a92b-d0667141b069';
const ASSET = 'a684848a-af63-4c8a-988e-37a2c01b20b5';
const HOST_A = 'agentic_process-aaaa1111-1111-4111-8111-111111111111';
const HOST_B = 'agentic_process-bbbb2222-2222-4222-8222-222222222222';

/** Navigate from `fromUrl` to `target`, returning the URL actually committed. */
function navigateFrom(fromUrl: string, target: DockPointer): string {
  // `here` reads the pending navigation before the browser URL, so a target left
  // over from the previous call would stand in for "where we are".
  NavigationActions.resetPendingNavigationForTests();
  window.history.pushState({}, '', fromUrl);
  const navigate = vi.fn();
  new NavigationActions(navigate, DockPointer.fromUrl(fromUrl)).openDock(target);
  return String(navigate.mock.calls[0][0]);
}

const hostedDoc = (host: string, asset = ASSET) =>
  `/dock/project/${PROJ}/process/${host}/display/editor/markdown/typeid/markdown-${asset}`;

describe('workspace host stickiness', () => {
  it('carries the live host onto a document opened from inside the workspace', () => {
    const other = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
    const target = DockPointer.fromUrl(`/dock/project/${PROJ}/editor/markdown/typeid/markdown-${other}`);

    const url = navigateFrom(hostedDoc(HOST_A), target);

    expect(url).toContain(`/process/${HOST_A}/display/`);
  });

  it('does NOT follow the document row into another workspace', () => {
    // Workspace A is on screen. A chip click navigates to the tab's OWN dock
    // pointer, which is hostless — the row's `parent_tab_id` may well point at
    // B by now, since one document is one tab whoever displays it.
    const other = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
    const chipDock = DockPointer.fromUrl(`/dock/project/${PROJ}/editor/markdown/typeid/markdown-${other}`);
    expect(chipDock.hostProcessId).toBeNull();

    expect(navigateFrom(hostedDoc(HOST_A), chipDock)).toContain(`/process/${HOST_A}/display/`);
    // …and an EXPLICIT host on the target still wins over the live one.
    expect(navigateFrom(hostedDoc(HOST_A), DockPointer.fromUrl(hostedDoc(HOST_B, other)))).toContain(
      `/process/${HOST_B}/display/`,
    );
  });

  it('drops the host when navigating AWAY to a non-adoptable surface', () => {
    // A process, a project or a list is a navigation out of the workspace;
    // inheriting the host there would resurrect a workspace around it.
    const project = DockPointer.forProject(PROJ);
    const process = new DockPointer(ViewType.SHELL, HOST_B);

    expect(navigateFrom(hostedDoc(HOST_A), project)).not.toContain('/process/');
    expect(navigateFrom(hostedDoc(HOST_A), process)).not.toContain('host=');
  });

  it('carries onto a terminal as a plain option — it has no project to nest under', () => {
    const shell = new DockPointer(ViewType.SHELL, 'shell-77777777-7777-4777-8777-777777777777');

    const url = navigateFrom(hostedDoc(HOST_A), shell);

    expect(url).toContain(`host=${encodeURIComponent(HOST_A)}`);
  });

  it('adds nothing when there is no live host', () => {
    const target = DockPointer.fromUrl(`/dock/project/${PROJ}/editor/markdown/typeid/markdown-${ASSET}`);

    const url = navigateFrom(`/dock/project/${PROJ}`, target);

    expect(url).not.toContain('/process/');
    expect(url).not.toContain('host=');
  });
});
