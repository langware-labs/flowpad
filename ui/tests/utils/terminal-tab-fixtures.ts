import type { TabProjectBucket } from '@src/tabs/use-tab-manager';
import { vi } from 'vitest';

/**
 * Shared test helper: a deterministic valid-v4-shaped UUID from a readable label
 * (TypeId enforces the entity-id policy, so test ids must be real v4/v5 UUIDs).
 * The label stays on `name` for assertions.
 */
export function uid(label: string): string {
  const hex = Array.from(label)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(8, '0')
    .slice(0, 8);
  return `${hex}-0000-4000-8000-000000000000`;
}

/** An open-project bucket as the tab manager reports it — enough of a Project
 *  for the project list to name it and nest it by mount path. */
export function makeBucket(id: string, displayName: string, tabCount: number): TabProjectBucket {
  const project = {
    id,
    typeId: { type: 'project', id },
    name: displayName,
    displayName,
    fs_storage_mount_path: `/tmp/${displayName}`,
    getDisplayName: () => displayName,
  };
  return {
    projectId: id,
    project: project as unknown as TabProjectBucket['project'],
    state: 'live',
    tabCount,
    recover: vi.fn(),
  };
}
