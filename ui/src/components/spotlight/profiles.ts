import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { ViewType } from '@sdk';
import type { SpotlightProfile } from './types';

const terminalProfile: SpotlightProfile = {
  id: 'terminal',
  label: msg`Search sessions`,
  placeholder: msg`Search sessions…`,
  // No `defaultEntityType` — the entity chip starts on "All" so the multi-type
  // fan-out hits each worker session type in parallel (matches the
  // behavior of the deleted SessionQuickSearchModal). Worker records are
  // record-types of the same conceptual "session" entity; both must surface.
  allowedEntityTypes: ['claude_session', 'codex_session', 'copilot_session'],
  showTerminalHistory: true,
  routeViaTerminal: true,
};

const defaultProfile: SpotlightProfile = {
  id: 'default',
  label: msg`Search`,
  placeholder: msg`Search…`,
};

export function resolveProfile(viewType: ViewType | undefined): SpotlightProfile {
  if (viewType === ViewType.SHELL) return terminalProfile;
  return defaultProfile;
}

export { defaultProfile, terminalProfile };
