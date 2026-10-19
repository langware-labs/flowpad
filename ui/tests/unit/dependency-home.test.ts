import { describe, expect, it, vi } from 'vitest';
import { Tab, dataManager, TypeId, type DependencyState } from '@sdk';
import { dependencyHomeDock } from '@src/project-home-page/dependency-home';
import { appDockAddress } from '@src/navigation/app-dock';
import { DockPointer } from '@src/navigation/DockPointer';
const provider = '77777777-7777-4777-8777-777777777777';
const consumer = '88888888-8888-4888-8888-888888888888';
const home = 'micro_app-99999999-9999-4999-8999-999999999999';
const dependency: DependencyState = {
  name: 'service',
  source: 'file:/service',
  required: true,
  path: '.',
  state: 'ready',
  dismissed: false,
  project_id: provider,
  home_page: home,
};
describe('dependency project homes', () => {
  it('preserves provider and consumer across reload and hands both to the app', () => {
    const dock = dependencyHomeDock(dependency, consumer)!;
    const restored = DockPointer.fromUrl(dock.toUrl());
    expect(restored.scopeProjectId).toBe(consumer);
    expect(appDockAddress(restored)?.options).toEqual({ providerProject: provider, consumerProject: consumer });
    expect(restored.tabHash).toBe(dock.tabHash);
  });
  it('materializes and restores the consumer tab without losing its execution provider', async () => {
    const dock = dependencyHomeDock(dependency, consumer)!;
    const lookup = vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue({ project_id: provider, typeId: new TypeId(home) } as never);
    const ensure = vi.spyOn(Tab, 'ensure').mockResolvedValue({ tabs: [], created: true });
    try {
      await Tab.getFromDockPointer(dock);
      expect(ensure).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ projectId: consumer }));
      const persisted = ensure.mock.calls[0][0];
      expect(JSON.parse(persisted).tabHash).toBe(dock.tabHash);
      const restored = DockPointer.fromJSON(persisted)!;
      expect(restored.tabHash).toBe(dock.tabHash);
      expect(restored.scopeProjectId).toBe(consumer);
      expect(appDockAddress(restored)?.options).toEqual({ providerProject: provider, consumerProject: consumer });
    } finally {
      lookup.mockRestore();
      ensure.mockRestore();
    }
  });
  it('reuses the same pair while separating consumers even for the same home app', () => {
    const dock = dependencyHomeDock(dependency, consumer)!;
    expect(dependencyHomeDock(dependency, consumer)?.tabHash).toBe(dock.tabHash);
    expect(dependencyHomeDock(dependency, provider)?.tabHash).not.toBe(dock.tabHash);
    expect(dock.withOption('runtime', 'dev').tabHash).toBe(dock.tabHash);
  });
  it.each(['./agentic-assets/webapp/admin', 'invalid', 'micro_app-not-an-id'])('ignores malformed home metadata: %s', (home_page) => {
    expect(dependencyHomeDock({ ...dependency, home_page }, consumer)).toBeNull();
  });
  it('does not offer a home until the provider and home resolve', () => {
    expect(dependencyHomeDock({ ...dependency, project_id: null }, consumer)).toBeNull();
    expect(dependencyHomeDock({ ...dependency, home_page: null }, consumer)).toBeNull();
  });
});
