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
 *
 * The original report carried one developer's absolute path
 * (``/Users/shlom/Documents/dev/flowpad-oss/.claude/skills/rca``), which made
 * this test pass only on that machine. The path was never the subject: what the
 * test needs is A REAL SKILL ON DISK, so it now discovers one under this
 * checkout's ``.claude/skills`` and builds the vfs ref from it.
 */
import { Skill, VFSPath, systemTools } from '@sdk';
import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SKILLS_DIR = path.join(REPO_ROOT, '.claude', 'skills');

/** An on-disk skill directory to point the editor at, or null when none exists.
 *
 * Prefers ``rca`` — the skill from the original report — so the test keeps
 * reproducing the reported case wherever that skill is checked in, and falls
 * back to the first skill that has a SKILL.md so a checkout without it still
 * exercises the discover path rather than silently losing the guard. */
function findSkillDir(): string | null {
  if (!existsSync(SKILLS_DIR)) return null;
  const hasManifest = (name: string) => {
    const dir = path.join(SKILLS_DIR, name);
    return (
      statSync(dir).isDirectory() && ['SKILL.md', 'SKILL.MD', 'skill.md'].some((f) => existsSync(path.join(dir, f)))
    );
  };
  const names = readdirSync(SKILLS_DIR).sort();
  const chosen = names.find((n) => n === 'rca' && hasManifest(n)) ?? names.find(hasManifest);
  return chosen ? path.join(SKILLS_DIR, chosen) : null;
}

describe('skill vfs editor resolution (the "not available" path)', () => {
  const signupInfo = getTestSignupInfo();
  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('resolves the on-disk skill via discover — both the relative path the router passes and the absolute one', async ({
    skip,
  }) => {
    const skillDir = findSkillDir();
    if (!skillDir) {
      skip(`no skill with a SKILL.md under ${SKILLS_DIR} to resolve`);
      return;
    }
    // The vfs ref the editor URL carries: the machine typeid followed by the
    // absolute path (…/editor/skill/vfs/<this>).
    const vfs = VFSPath.parse(`compute_node-@local${skillDir}`);

    // AssetEditorRouter builds FSRef(vfs.entitySubPath, ...) — relative, no leading slash.
    expect(vfs.entitySubPath).toBe(skillDir.replace(/^\//, ''));
    expect(vfs.machinePath).toBe(skillDir);

    // The router-passed RELATIVE path resolves (this is what useEntityByPath sends).
    const viaRelative = await systemTools.discoverByPath(Skill.type, vfs.entitySubPath);
    expect(viaRelative?.type).toBe('skill');

    // The absolute path resolves too — neither form 404s, so no MissingAssetCard.
    const viaAbsolute = await systemTools.discoverByPath(Skill.type, vfs.machinePath);
    expect(viaAbsolute?.type).toBe('skill');
  }, 15000);
});
