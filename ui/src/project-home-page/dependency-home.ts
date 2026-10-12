import { Agent, TypeId, isTypeId, type DependencyState } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { dockForDisplayTarget } from '@src/navigation/display-target-pointer';
import { isAppType } from '@src/navigation/app-dock';
import { projectScope } from '@src/lib/scope-filter';

export const PROVIDER_PROJECT_PARAM = 'providerProject';
export const CONSUMER_PROJECT_PARAM = 'consumerProject';
export const HOME_AGENT_PARAM = 'homeAgent';

/** Both identities travel with the URL and into the app's query string. */
export function dependencyHomeDock(dependency: DependencyState, consumerProjectId: string): DockPointer | null {
  if (!dependency.project_id || !dependency.home_page || !isTypeId(dependency.home_page)) return null;
  const asset = new TypeId(dependency.home_page);
  const dock = isAppType(asset.type)
    ? DockPointer.forAppEntity(asset)
    : dockForDisplayTarget({ kind: 'entity', typeid: dependency.home_page, type: asset.type });
  return (
    dock
      ?.withScopeFilter(projectScope(consumerProjectId))
      .withOption(PROVIDER_PROJECT_PARAM, dependency.project_id)
      .withOption(CONSUMER_PROJECT_PARAM, consumerProjectId)
      .withOption(HOME_AGENT_PARAM, asset.type === Agent.type ? dependency.home_page : null) ?? null
  );
}
