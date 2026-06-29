/**
 * skillFolder adapter — unit tests for the skill-row → file-tree bridge in the
 * Assets sidebar. Verifies the create-file/create-folder actions are wired and
 * node ids are stable. Directory listing + create/delete round-trips are
 * validated in-app (they require the real fsStore/compute node).
 */

import { describe, it, expect } from 'vitest';
import { skillFolderNodeId, skillCreateActions } from '@src/components/browseable-tree/adapters/skillFolder';

const SKILL_ABS = '/Users/x/.claude/skills/slick';

describe('skillFolder adapter', () => {
  it('builds a stable folder node id from an absolute path', () => {
    expect(skillFolderNodeId(`${SKILL_ABS}/references`)).toBe(
      'skill-folder:/Users/x/.claude/skills/slick/references',
    );
  });

  it('exposes New file and New folder create actions for a folder', () => {
    const actions = skillCreateActions(SKILL_ABS, 'asset:skill:Users/x/.claude/skills/slick');
    expect(actions.map((a) => a.label)).toEqual(['New file', 'New folder']);
    // Each action is a side-effect run() with no navigation.
    expect(actions.every((a) => typeof a.run === 'function')).toBe(true);
  });
});
