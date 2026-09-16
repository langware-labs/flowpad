import { describe, expect, it, vi } from 'vitest';

/**
 * Which type an activity's subject_entity names.
 *
 * A TypeId's id contains dashes (it is a uuid), so splitting on the LAST one looks right
 * and is wrong for every scoped activity: the type came back as
 * `agentic_process-<most-of-the-uuid>`, the registry lookup missed, and the row fell
 * silently to the generic glyph — the exact failure the type-icon rule exists to prevent.
 */

vi.mock('@src/components/graph-view/icons/iconRegistry', () => ({
  iconForType: () => null,
}));

import { typeOfSubject } from '@src/components/footer/activity-icon';

describe('typeOfSubject', () => {
  it('reads the type off a uuid-suffixed TypeId', () => {
    expect(typeOfSubject('agentic_process-9e1d4c2a-1f3b-4a5c-a716-446655440000')).toBe('agentic_process');
  });

  it('reads the type off a named id', () => {
    expect(typeOfSubject('compute_node-@local')).toBe('compute_node');
  });

  it('is null for an absent or unparseable subject_entity', () => {
    expect(typeOfSubject(null)).toBeNull();
    expect(typeOfSubject(undefined)).toBeNull();
    expect(typeOfSubject('not-a-typeid-')).toBeNull();
  });
});
