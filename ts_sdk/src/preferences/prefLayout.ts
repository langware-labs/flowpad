/**
 * How the Preferences screen lays out the surfaced prefs: groups in a left menu,
 * tabs inside each group. A UI layer only — pref keys (and their `category`) do
 * not change. The address is `/dock/preferences/<group>/<tab>`.
 *
 * `flow_sdk/core/dock_address.py` (`PREFERENCE_TABS`) names the same tabs for
 * smart navigation; `ui/tests/unit/pref-layout.test.ts` checks they agree.
 */
import { PrefKey } from './prefRegistry';

/** A tab that renders something other than pref rows. */
export type PrefCustomTab = 'toplog';

export interface PrefTab {
  id: string;
  keys: PrefKey[];
  custom?: PrefCustomTab;
}

export interface PrefGroup {
  id: string;
  tabs: PrefTab[];
}

export const PREF_GROUPS: PrefGroup[] = [
  {
    id: 'general',
    tabs: [
      {
        id: 'appearance',
        keys: [PrefKey.VIEW_MODE, PrefKey.LOCALE, PrefKey.SHOW_SYSTEM_PROJECTS, PrefKey.SHOW_SYSTEM_SKILLS],
      },
      { id: 'notifications', keys: [PrefKey.SOUND_ENABLED, PrefKey.SOUND_KEY] },
    ],
  },
  {
    id: 'terminal',
    tabs: [
      { id: 'behavior', keys: [PrefKey.DEFAULT_TERMINAL, PrefKey.COMMAND_LINK_CONFIRM] },
      { id: 'display', keys: [PrefKey.BUFFER_SYNC_UPDATES, PrefKey.SCROLLBACK_LINES] },
    ],
  },
  {
    id: 'ai',
    tabs: [
      { id: 'models', keys: [PrefKey.LLM_DEFAULT_SIZE, PrefKey.LLM_SOURCE_ORDER] },
      { id: 'chat', keys: [PrefKey.CHAT_SHOW_TOOLS] },
    ],
  },
  {
    id: 'indexing',
    tabs: [
      {
        id: 'auto-index',
        keys: [
          PrefKey.AUTO_INDEX_ENABLED,
          PrefKey.AUTO_INDEX_TYPE,
          PrefKey.AUTO_INDEX_TRIGGER,
          PrefKey.AUTO_INDEX_FUNCTION,
        ],
      },
      { id: 'engine', keys: [PrefKey.DISKIO_BACKEND] },
    ],
  },
  {
    id: 'sharing',
    tabs: [
      {
        id: 'sharing',
        keys: [PrefKey.SHARE_MESSAGE_STATUS, PrefKey.SHARE_CLOUD_LINK, PrefKey.SMART_NAVIGATION_SIGNIN],
      },
      { id: 'this-machine', keys: [PrefKey.IT_SESSIONS] },
    ],
  },
  {
    id: 'developer',
    tabs: [
      { id: 'trace-logging', keys: [], custom: 'toplog' },
      { id: 'hook-sniffer', keys: [PrefKey.SNIFFER_MAX_EVENTS] },
      { id: 'errors', keys: [PrefKey.ERROR_DEDUPLICATE] },
      { id: 'smart-navigation', keys: [PrefKey.SMART_NAVIGATION_LOG] },
      { id: 'experimental', keys: [PrefKey.EXPERIMENTAL_FLAGS, PrefKey.ONBOARDING_WELCOME] },
    ],
  },
];

/** The old one-segment pointers (a pref category, or the `appearance` alias) → their tab now. */
const LEGACY_POINTERS: Record<string, string> = {
  appearance: 'general/appearance',
  ui: 'general/appearance',
  i18n: 'general/appearance',
  notifications: 'general/notifications',
  auto_index: 'indexing/auto-index',
  llm: 'ai/models',
  chat: 'ai/chat',
  advanced: 'developer/smart-navigation',
  errors: 'developer/errors',
  debug: 'developer/hook-sniffer',
  onboarding: 'developer/experimental',
};

export interface PrefPlace {
  group: PrefGroup;
  tab: PrefTab;
  /** The canonical pointer, `<group>/<tab>`. */
  pointer: string;
}

function place(group: PrefGroup, tab: PrefTab): PrefPlace {
  return { group, tab, pointer: `${group.id}/${tab.id}` };
}

/**
 * The group and tab a Preferences pointer names. A legacy category pointer maps to
 * its tab now; a bare group opens its first tab; anything unknown opens the first
 * group's first tab.
 */
export function resolvePreferencesPointer(pointer: string | null | undefined): PrefPlace {
  const raw = (pointer ?? '').trim().replace(/^\/+|\/+$/g, '');
  const [groupId, tabId] = (LEGACY_POINTERS[raw] ?? raw).split('/');
  const group = PREF_GROUPS.find((g) => g.id === groupId) ?? PREF_GROUPS[0];
  const tab = group.tabs.find((t) => t.id === tabId) ?? group.tabs[0];
  return place(group, tab);
}
