/**
 * Shared TerminalTab fixture builders for the Phase-0 tab characterization tests.
 *
 * Entity ids must be valid v4/v5 UUIDs (TypeId enforces the entity-id policy), so
 * `uid` deterministically derives a valid v4-shaped UUID from a readable label —
 * the label itself stays on `name` for assertions.
 */
import { AgenticProcess, Shell, TypeId } from '@sdk';
import { type TerminalTab } from '@src/tabs/useTabs';

/** Deterministic valid-v4-shaped UUID from a readable label (test-only). */
export function uid(label: string): string {
  const hex = Array.from(label)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(8, '0')
    .slice(0, 8);
  return `${hex}-0000-4000-8000-000000000000`;
}

export function shellTab(label: string, tabOrder = 0, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    targetTypeId: new TypeId(Shell.type, uid(label)),
    shellId: uid(label),
    processId: null,
    tabOrder,
    name: label,
    type: 'plain',
    isDisabled: false,
    statusReason: '',
    projectId: null,
    projectDisplayName: null,
    ...extra,
  };
}

export function procTab(label: string, tabOrder = 0, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    targetTypeId: new TypeId(AgenticProcess.type, uid(label)),
    shellId: uid(`${label}-shell`),
    processId: uid(label),
    tabOrder,
    name: label,
    type: 'claude',
    isDisabled: false,
    statusReason: '',
    projectId: null,
    projectDisplayName: null,
    ...extra,
  };
}
