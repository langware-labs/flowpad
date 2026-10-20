/**
 * The apps and agents button: a lone app opens directly; otherwise a list
 * opens each entry by URL with its registered type icon.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@src/components/ui/tooltip';

const openDock = vi.hoisted(() => vi.fn());
const dock = vi.hoisted(() => ({ current: null as unknown }));
const agents = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock('@src/hooks/use-project-agents', () => ({ useProjectAgents: () => ({ agents: agents.current }) }));
const apps = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock }, currentDock: dock.current }),
}));
vi.mock('@src/components/top-nav-bar/use-project-apps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/top-nav-bar/use-project-apps')>()),
  useProjectApps: () => apps.current,
}));

import { Agent, TypeId, type Project } from '@sdk';
import { AppButton } from '@src/components/top-nav-bar/AppButton';
import { projectAppDock, type ProjectApp } from '@src/components/top-nav-bar/use-project-apps';
import { DockPointer } from '@src/navigation/DockPointer';

const SHOP = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const DEP = '33333333-3333-4333-8333-333333333333';
const project = { id: 'p1', name: 'Trips' } as unknown as Project;
const entry = (id: string, name: string, audience = 'app', providerProjectId = 'p1') =>
  ({ app: { id, name, audience, type: 'micro_app' }, providerProjectId }) as unknown as ProjectApp;
const shop = entry(SHOP, 'shop');
const admin = entry(ADMIN, 'back-office', 'admin');
const docs = entry(DEP, 'docs', 'app', 'dep');
const showingApp = (id: string) => DockPointer.forAppEntity(new TypeId(`micro_app-${id}`));
const mount = () =>
  render(
    <TooltipProvider>
      <AppButton project={project} />
    </TooltipProvider>,
  );

beforeEach(() => {
  openDock.mockClear();
  dock.current = DockPointer.forAutomations();
  apps.current = [];
  agents.current = [];
});
afterEach(cleanup);

describe('the apps button', () => {
  it('is absent when the project has no apps or agents', () => {
    mount();
    expect(screen.queryByTestId('top-nav-app')).toBeNull();
    expect(screen.queryByTestId('top-nav-apps')).toBeNull();
  });

  it.each([false, true])('lists agents with or without apps (with apps: %s)', async (withApps) => {
    const agent = new Agent({ id: SHOP, name: 'helper' });
    agents.current = [agent];
    apps.current = withApps ? [shop] : [];
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('top-nav-apps'));
    const item = screen.getByTestId('top-nav-agent-helper');
    expect(item.querySelector('svg')).not.toBeNull();
    if (withApps) expect(screen.getByTestId('top-nav-app-shop').querySelector('svg')).not.toBeNull();
    await user.click(item);
    expect(openDock).toHaveBeenCalledWith(agent.dockPointer);
  });

  describe('with one app', () => {
    beforeEach(() => {
      apps.current = [shop];
    });

    it('opens it in place, by URL alone', async () => {
      mount();
      const button = screen.getByTestId('top-nav-app');
      expect(button.getAttribute('aria-label')).toBe('Apps and agents');
      await userEvent.setup().click(button);
      expect(openDock).toHaveBeenCalledTimes(1);
      expect(openDock.mock.calls[0][0].toUrl('/')).toBe(projectAppDock(shop, 'p1').toUrl('/'));
      expect(openDock.mock.calls[0][2]).toBeUndefined();
    });

    it('rests while that app is the one on screen', () => {
      dock.current = showingApp(SHOP);
      mount();
      const button = screen.getByTestId('top-nav-app');
      expect(button).toHaveProperty('disabled', true);
      expect(button.getAttribute('aria-label')).toBe('Apps and agents');
    });
  });

  describe('with several apps', () => {
    beforeEach(() => {
      apps.current = [shop, admin, docs];
    });

    it('lists each app with its type, and marks a dependency', async () => {
      mount();
      expect(screen.queryByTestId('top-nav-app')).toBeNull();
      await userEvent.setup().click(screen.getByTestId('top-nav-apps'));
      expect(screen.getByTestId('top-nav-app-shop').textContent).toBe('shopUser');
      expect(screen.getByTestId('top-nav-app-back-office').textContent).toBe('back-officeAdmin');
      expect(screen.getByTestId('top-nav-app-docs').textContent).toBe('docsPackageUser');
      expect(openDock).not.toHaveBeenCalled();
    });

    it('opens the chosen app in place', async () => {
      mount();
      const user = userEvent.setup();
      await user.click(screen.getByTestId('top-nav-apps'));
      await user.click(screen.getByTestId('top-nav-app-back-office'));
      expect(openDock).toHaveBeenCalledTimes(1);
      expect(openDock.mock.calls[0][0].toUrl('/')).toBe(projectAppDock(admin, 'p1').toUrl('/'));
      expect(openDock.mock.calls[0][2]).toBeUndefined();
    });

    it('marks the app on screen', async () => {
      dock.current = showingApp(ADMIN);
      mount();
      await userEvent.setup().click(screen.getByTestId('top-nav-apps'));
      const shown = (name: string) =>
        screen.getByTestId(`top-nav-app-${name}`).querySelector('svg.lucide-check')?.getAttribute('aria-hidden');
      expect(shown('back-office')).toBe('false');
      expect(shown('shop')).toBe('true');
    });
  });
});
