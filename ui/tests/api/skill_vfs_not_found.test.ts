/**
 * RCA regression guard for the skill editor "not available" report.
 *
 * URL under suspicion:
 *   /dock/project/<pid>/editor/skill/vfs/compute_node-@local/Users/.../.claude/skills/rca
 *
 * The editor chain is:
 *   AssetEditorRouter (vfs branch) → FSRef(vfs.entitySubPath, vfs.typeId)
 *     → EntityResolutionGate<Skill> → useEntityByPath(Skill.type, fsRef)
 *       → bulk /graph/skill match on asset_ref, else systemTools.discoverByPath.
 * Only a discover 404 (or an orphan row) makes the gate render MissingAssetCard
 * ("not available"). This test proves the data layer does NOT 404 for a real
 * on-disk skill — via the relative entitySubPath the router actually passes AND
 * the absolute machinePath — so the "not available" symptom is NOT a discover
 * miss. Real backend, no mocks.
 */
import { Skill, VFSPath, systemTools } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

// The exact vfs ref from the failing URL (…/editor/skill/vfs/<this>).
const VFS_VALUE =
  'compute_node-@local/Users/shlom/Documents/dev/flowpad-oss/.claude/skills/rca';

describe('skill vfs editor resolution (the "not available" path)', () => {
  const signupInfo = getTestSignupInfo();
  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('resolves the on-disk skill via discover — both the relative path the router passes and the absolute one', async () => {
    const vfs = VFSPath.parse(VFS_VALUE);
    // AssetEditorRouter builds FSRef(vfs.entitySubPath, ...) — relative, no leading slash.
    expect(vfs.entitySubPath).toBe('Users/shlom/Documents/dev/flowpad-oss/.claude/skills/rca');
    expect(vfs.machinePath).toBe('/Users/shlom/Documents/dev/flowpad-oss/.claude/skills/rca');

    // The router-passed RELATIVE path resolves (this is what useEntityByPath sends).
    const viaRelative = await systemTools.discoverByPath(Skill.type, vfs.entitySubPath);
    expect(viaRelative?.type).toBe('skill');

    // The absolute path resolves too — neither form 404s, so no MissingAssetCard.
    const viaAbsolute = await systemTools.discoverByPath(Skill.type, vfs.machinePath);
    expect(viaAbsolute?.type).toBe('skill');
  }, 15000);
});
