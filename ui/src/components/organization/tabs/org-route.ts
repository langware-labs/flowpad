/**
 * Where the People & teams page is, read from and written to the URL — so a reload, Back and a
 * shared link land on the same org, tab and team.
 *
 * `/dock/hub/organization[/team/<id>]?org=<id>&tab=<tab>`: the tab and the org ride as dock
 * options, the team being looked at as the pointer (the grammar `view-types.ts` documents for
 * this view).
 */
import { PageId, ViewType } from '@sdk';
import { useCallback } from 'react';

import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

export type OrgTab = 'teams' | 'members' | 'billing' | 'general';

const TABS: readonly OrgTab[] = ['teams', 'members', 'billing', 'general'];
const TEAM_POINTER = /^team\/(.+)$/;

export function useOrgRoute() {
  const { navigation, currentDock } = useDockNavigation();
  const options = currentDock?.options ?? {};
  const rawTab = options.tab as OrgTab | undefined;
  const tab: OrgTab = rawTab && TABS.includes(rawTab) ? rawTab : 'teams';
  const teamId = TEAM_POINTER.exec(currentDock?.pointer ?? '')?.[1] ?? null;
  const orgId: string | null = options.org ?? null;

  const go = useCallback(
    (next: { org?: string | null; tab?: OrgTab; team?: string | null }) => {
      const org = next.org === undefined ? orgId : next.org;
      const opts: Record<string, string> = { tab: next.tab ?? tab };
      if (org) opts.org = org;
      const pointer = next.team ? `team/${next.team}` : undefined;
      navigation.openDock(new DockPointer(ViewType.ORGANIZATION, pointer, opts, undefined, PageId.HUB));
    },
    [navigation, orgId, tab],
  );

  return {
    orgId,
    tab,
    teamId,
    setOrg: (org: string) => go({ org, tab: 'teams', team: null }),
    setTab: (next: OrgTab) => go({ tab: next, team: null }),
    openTeam: (team: string) => go({ tab: 'teams', team }),
    closeTeam: () => go({ tab: 'teams', team: null }),
  };
}
